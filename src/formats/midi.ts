import type { Chip } from '../chips/Chip.ts';
import { Mt32Synth } from '../chips/Mt32Synth.ts';
import { Opl } from '../chips/Opl.ts';
import type { PlayerInfo, RetroPlayer } from '../players/Player.ts';
import { Region } from '../region.ts';
import type { LoadOptions } from './mwa.ts';

/**
 * General MIDI: Standard MIDI Files (formats 0 and 1) and Miles / Sierra / LucasArts `.xmi` (eXtended MIDI), played on
 * the OPL2 through a small FM sound set, converted to an SMF for any other synthesiser (`xmiToSmf`: pass the result to
 * mwg's `renderMidiToBuffer`).
 *
 * The built-in sound set is generic (one FM patch per General MIDI family, procedurally defined): it plays the right
 * notes at the right times, but it is not the instrument bank of any sound card driver (the AIL / Miles `GENMIDI`
 * banks are proprietary and not included), so timbres differ from the original card.
 */

export interface MidiEvent {
	/** time in seconds from the start */
	time: number;
	status: number;
	data1: number;
	data2: number;
}

export interface MidiSong {
	events: MidiEvent[];
	/** tempo-map duration in seconds */
	duration: number;
	title?: string;
}

const readVlq = (b: Uint8Array, p: number): [number, number] => {
	let v = 0;
	for (let i = 0; i < 4 && p < b.length; i++) {
		const c = b[p++];
		v = (v << 7) | (c & 0x7f);
		if (!(c & 0x80)) break;
	}
	return [v, p];
};

/**
 * The song without the silence before its first note: the time of the first note-on is cut from every later event, and the
 * setup messages sent before it (program changes, controllers, tempo-less meta data) are kept at time 0. A song that
 * starts on its first note, or that has no note, is returned as it is.
 */
export function trimLeadingSilence(song: MidiSong): MidiSong {
	const first = song.events.find((event) => (event.status & 0xf0) === 0x90 && event.data2 > 0);
	if (!first || first.time <= 0) return song;
	const offset = first.time;
	return {
		...song,
		events: song.events.map((event) => ({ ...event, time: Math.max(0, event.time - offset) })),
		duration: Math.max(0, song.duration - offset),
	};
}

export function isSmf(b: Uint8Array): boolean {
	return b.length > 14 && String.fromCharCode(...b.subarray(0, 4)) === 'MThd';
}
export function isXmi(b: Uint8Array): boolean {
	return (
		b.length > 24 &&
		String.fromCharCode(...b.subarray(0, 4)) === 'FORM' &&
		String.fromCharCode(...b.subarray(8, 12)) === 'XDIR'
	);
}

/** Parse a Standard MIDI File (formats 0 and 1, tick based timing) into timed events with the tempo map applied */
export function parseSmf(b: Uint8Array): MidiSong {
	if (!isSmf(b)) throw new Error('not a Standard MIDI File');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const nTracks = v.getUint16(10, false);
	const division = v.getUint16(12, false);
	if (division & 0x8000) throw new Error('SMPTE time division is not supported');
	let p = 14;
	const tracks: { tick: number; status: number; d1: number; d2: number; tempo?: number }[][] = [];
	let title: string | undefined;
	for (let t = 0; t < nTracks && p + 8 <= b.length; t++) {
		const len = v.getUint32(p + 4, false);
		let q = p + 8;
		const end = Math.min(b.length, q + len);
		p = end;
		const ev: (typeof tracks)[number] = [];
		let tick = 0;
		let running = 0;
		while (q < end) {
			let delta: number;
			[delta, q] = readVlq(b, q);
			tick += delta;
			let st = b[q];
			if (st & 0x80) q++;
			else st = running;
			if (st === 0xff) {
				const type = b[q++];
				let l: number;
				[l, q] = readVlq(b, q);
				if (type === 0x51 && l === 3)
					ev.push({ tick, status: 0xff, d1: 0, d2: 0, tempo: (b[q] << 16) | (b[q + 1] << 8) | b[q + 2] });
				else if (type === 0x03 && !title) title = String.fromCharCode(...b.subarray(q, q + l));
				q += l;
				if (type === 0x2f) break;
			} else if (st === 0xf0 || st === 0xf7) {
				let l: number;
				[l, q] = readVlq(b, q);
				q += l;
			} else {
				running = st;
				const n = st >> 4 === 0xc || st >> 4 === 0xd ? 1 : 2;
				ev.push({ tick, status: st, d1: b[q], d2: n === 2 ? b[q + 1] : 0 });
				q += n;
			}
		}
		tracks.push(ev);
	}
	const merged = tracks.flat().sort((a, b2) => a.tick - b2.tick);
	const events: MidiEvent[] = [];
	let tempo = 500000;
	let lastTick = 0;
	let seconds = 0;
	for (const e of merged) {
		seconds += ((e.tick - lastTick) * tempo) / 1e6 / division;
		lastTick = e.tick;
		if (e.tempo !== undefined) tempo = e.tempo;
		else events.push({ time: seconds, status: e.status, data1: e.d1, data2: e.d2 });
	}
	return { events, duration: seconds, title };
}

/**
 * Convert an `.xmi` (IFF: FORM XDIR / CAT XMID / FORM XMID / EVNT) to a format-0 Standard MIDI File. XMI events carry
 * the *duration* of each note after its note-on (a variable length value) instead of a note-off, delays are sums of
 * bytes below 0x80, and the clock is 120 ticks per second: ticks are converted to a 500000 us/beat tempo with a
 * division of 60, which keeps real time. Only the first sequence of the file is converted.
 */
export function xmiToSmf(b: Uint8Array): Uint8Array {
	if (!isXmi(b)) throw new Error('not an XMI file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const tag = (o: number): string => String.fromCharCode(...b.subarray(o, o + 4));
	// find the first EVNT chunk
	let evnt = -1;
	for (let o = 12; o + 8 < b.length; o++) {
		if (tag(o) === 'EVNT') {
			evnt = o;
			break;
		}
	}
	if (evnt < 0) throw new Error('XMI: no EVNT chunk');
	const len = v.getUint32(evnt + 4, false);
	let p = evnt + 8;
	const end = Math.min(b.length, p + len);
	const out: { tick: number; bytes: number[] }[] = [];
	const offs: { tick: number; bytes: number[] }[] = [];
	let tick = 0;
	while (p < end) {
		const c = b[p];
		if (c < 0x80) {
			tick += c; // a delay
			p++;
			continue;
		}
		p++;
		if (c === 0xff) {
			const type = b[p++];
			let l: number;
			[l, p] = readVlq(b, p);
			if (type === 0x2f) break;
			if (type === 0x51 && l === 3) {
				/* tempo is fixed by the conversion */
			}
			p += l;
		} else if (c === 0xf0 || c === 0xf7) {
			let l: number;
			[l, p] = readVlq(b, p);
			p += l;
		} else if (c >> 4 === 0x9) {
			const note = b[p++];
			const vel = b[p++];
			let dur: number;
			[dur, p] = readVlq(b, p);
			out.push({ tick, bytes: [c, note, vel] });
			offs.push({ tick: tick + dur, bytes: [0x80 | (c & 15), note, 0] });
		} else {
			const n = c >> 4 === 0xc || c >> 4 === 0xd ? 1 : 2;
			out.push({ tick, bytes: [c, ...Array.from(b.subarray(p, p + n))] });
			p += n;
		}
	}
	const all = [...out, ...offs].sort((a, b2) => a.tick - b2.tick);
	const track: number[] = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20]; // 500000 us per beat
	let last = 0;
	const vlq = (n: number): number[] => {
		const r = [n & 0x7f];
		for (n >>= 7; n > 0; n >>= 7) r.unshift((n & 0x7f) | 0x80);
		return r;
	};
	for (const e of all) {
		track.push(...vlq(e.tick - last), ...e.bytes);
		last = e.tick;
	}
	track.push(0, 0xff, 0x2f, 0);
	const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 60];
	const len4 = [
		(track.length >> 24) & 255,
		(track.length >> 16) & 255,
		(track.length >> 8) & 255,
		track.length & 255,
	];
	return Uint8Array.from([...head, 0x4d, 0x54, 0x72, 0x6b, ...len4, ...track]);
}

// ------------------------------------------------------------------------------------------------ OPL sound set

interface FmPatch {
	modMul: number;
	carMul: number;
	modTl: number;
	attack: number;
	decay: number;
	sustain: number;
	release: number;
	feedback: number;
	additive: boolean;
	modWave: number;
	carWave: number;
	sustained: boolean;
}

/** one generic patch per General MIDI family of eight programs (0-15) */
const FAMILY: FmPatch[] = [
	{
		modMul: 1,
		carMul: 1,
		modTl: 24,
		attack: 15,
		decay: 4,
		sustain: 8,
		release: 5,
		feedback: 2,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: false,
	}, // piano
	{
		modMul: 7,
		carMul: 1,
		modTl: 20,
		attack: 15,
		decay: 8,
		sustain: 10,
		release: 7,
		feedback: 0,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: false,
	}, // chromatic percussion
	{
		modMul: 2,
		carMul: 1,
		modTl: 30,
		attack: 12,
		decay: 0,
		sustain: 0,
		release: 6,
		feedback: 3,
		additive: true,
		modWave: 0,
		carWave: 0,
		sustained: true,
	}, // organ
	{
		modMul: 1,
		carMul: 1,
		modTl: 22,
		attack: 15,
		decay: 6,
		sustain: 6,
		release: 5,
		feedback: 4,
		additive: false,
		modWave: 1,
		carWave: 0,
		sustained: false,
	}, // guitar
	{
		modMul: 1,
		carMul: 1,
		modTl: 28,
		attack: 15,
		decay: 5,
		sustain: 7,
		release: 5,
		feedback: 3,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: false,
	}, // bass
	{
		modMul: 2,
		carMul: 1,
		modTl: 34,
		attack: 8,
		decay: 2,
		sustain: 2,
		release: 6,
		feedback: 1,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: true,
	}, // strings
	{
		modMul: 2,
		carMul: 1,
		modTl: 36,
		attack: 7,
		decay: 2,
		sustain: 1,
		release: 6,
		feedback: 0,
		additive: true,
		modWave: 0,
		carWave: 0,
		sustained: true,
	}, // ensemble
	{
		modMul: 1,
		carMul: 1,
		modTl: 18,
		attack: 12,
		decay: 2,
		sustain: 3,
		release: 6,
		feedback: 5,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: true,
	}, // brass
	{
		modMul: 1,
		carMul: 1,
		modTl: 30,
		attack: 12,
		decay: 1,
		sustain: 2,
		release: 6,
		feedback: 4,
		additive: false,
		modWave: 1,
		carWave: 0,
		sustained: true,
	}, // reed
	{
		modMul: 1,
		carMul: 1,
		modTl: 44,
		attack: 11,
		decay: 1,
		sustain: 1,
		release: 6,
		feedback: 0,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: true,
	}, // pipe
	{
		modMul: 1,
		carMul: 1,
		modTl: 24,
		attack: 14,
		decay: 1,
		sustain: 1,
		release: 6,
		feedback: 6,
		additive: false,
		modWave: 2,
		carWave: 0,
		sustained: true,
	}, // synth lead
	{
		modMul: 2,
		carMul: 1,
		modTl: 38,
		attack: 6,
		decay: 1,
		sustain: 1,
		release: 4,
		feedback: 1,
		additive: true,
		modWave: 0,
		carWave: 0,
		sustained: true,
	}, // synth pad
	{
		modMul: 3,
		carMul: 1,
		modTl: 22,
		attack: 10,
		decay: 3,
		sustain: 4,
		release: 5,
		feedback: 5,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: false,
	}, // synth effects
	{
		modMul: 2,
		carMul: 1,
		modTl: 26,
		attack: 15,
		decay: 5,
		sustain: 6,
		release: 6,
		feedback: 3,
		additive: false,
		modWave: 1,
		carWave: 1,
		sustained: false,
	}, // ethnic
	{
		modMul: 5,
		carMul: 1,
		modTl: 16,
		attack: 15,
		decay: 9,
		sustain: 12,
		release: 8,
		feedback: 1,
		additive: false,
		modWave: 0,
		carWave: 0,
		sustained: false,
	}, // percussive
	{
		modMul: 15,
		carMul: 1,
		modTl: 10,
		attack: 15,
		decay: 7,
		sustain: 12,
		release: 7,
		feedback: 7,
		additive: false,
		modWave: 3,
		carWave: 3,
		sustained: false,
	}, // sound effects
];
const DRUM: FmPatch = {
	modMul: 13,
	carMul: 5,
	modTl: 6,
	attack: 15,
	decay: 9,
	sustain: 15,
	release: 9,
	feedback: 7,
	additive: false,
	modWave: 3,
	carWave: 3,
	sustained: false,
};
const OP = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];

/** midi note + bend to OPL fnum / block for a 49716 Hz chip */
function oplFreq(note: number, bendSemis: number, rate: number): { fnum: number; block: number } {
	const hz = 440 * 2 ** ((note + bendSemis - 69) / 12);
	for (let block = 0; block < 8; block++) {
		const fnum = Math.round((hz * 2 ** (20 - block)) / rate);
		if (fnum < 1024) return { fnum, block };
	}
	return { fnum: 1023, block: 7 };
}

interface Voice {
	channel: number;
	note: number;
	age: number;
	on: boolean;
}

/** Drives an OPL2 with MIDI messages: 9 voices, channel volume / expression / pan-less, pitch bend, drums on channel 10 */
export class OplMidiSink {
	readonly chip: Opl;
	private readonly voices: Voice[] = Array.from({ length: 9 }, () => ({ channel: -1, note: -1, age: 0, on: false }));
	private readonly program = new Array<number>(16).fill(0);
	private readonly volume = new Array<number>(16).fill(100);
	private readonly expression = new Array<number>(16).fill(127);
	private readonly bend = new Array<number>(16).fill(0);
	private readonly bendRange = new Array<number>(16).fill(2);
	private readonly loaded = new Array<FmPatch | null>(9).fill(null);
	private readonly rate: number;
	private age = 0;

	constructor(sampleRate: number) {
		this.chip = new Opl({ sampleRate });
		this.rate = this.chip.nativeRate;
		this.chip.write(0x01, 0x20);
	}

	private w(reg: number, v: number): void {
		this.chip.write(reg, v);
	}

	private tl(patchTl: number, velocity: number, ch: number): number {
		const level = (velocity / 127) * (this.volume[ch] / 127) * (this.expression[ch] / 127);
		const att = level <= 0 ? 63 : Math.min(63, Math.round((-20 * Math.log10(level)) / 0.75));
		return Math.min(63, patchTl + att);
	}

	private load(voice: number, p: FmPatch): void {
		if (this.loaded[voice] === p) return;
		this.loaded[voice] = p;
		const o = OP[voice];
		this.w(0x20 + o, (p.sustained ? 0x20 : 0) | p.modMul);
		this.w(0x23 + o, (p.sustained ? 0x20 : 0) | p.carMul);
		this.w(0x60 + o, (p.attack << 4) | p.decay);
		this.w(0x63 + o, (p.attack << 4) | p.decay);
		this.w(0x80 + o, (p.sustain << 4) | p.release);
		this.w(0x83 + o, (p.sustain << 4) | p.release);
		this.w(0xe0 + o, p.modWave);
		this.w(0xe3 + o, p.carWave);
		this.w(0xc0 + voice, (p.feedback << 1) | (p.additive ? 1 : 0));
	}

	private keyOn(voice: number, note: number, ch: number, on: boolean): void {
		const { fnum, block } = oplFreq(note, (this.bend[ch] / 8192) * this.bendRange[ch], this.rate);
		this.w(0xa0 + voice, fnum & 255);
		this.w(0xb0 + voice, (on ? 0x20 : 0) | (block << 2) | (fnum >> 8));
	}

	event(status: number, d1: number, d2: number): void {
		const ch = status & 15;
		switch (status & 0xf0) {
			case 0x80:
				return this.noteOff(ch, d1);
			case 0x90:
				return d2 === 0 ? this.noteOff(ch, d1) : this.noteOn(ch, d1, d2);
			case 0xb0:
				if (d1 === 7) this.volume[ch] = d2;
				else if (d1 === 11) this.expression[ch] = d2;
				else if (d1 === 123 || d1 === 120)
					for (let i = 0; i < 9; i++) if (this.voices[i].channel === ch && this.voices[i].on) this.release(i);
				break;
			case 0xc0:
				this.program[ch] = d1;
				break;
			case 0xe0: {
				this.bend[ch] = (d1 | (d2 << 7)) - 8192;
				for (let i = 0; i < 9; i++)
					if (this.voices[i].channel === ch && this.voices[i].on)
						this.keyOn(i, this.voices[i].note, ch, true);
				break;
			}
		}
	}

	private release(i: number): void {
		this.keyOn(i, this.voices[i].note, this.voices[i].channel, false);
		this.voices[i].on = false;
	}

	private noteOff(ch: number, note: number): void {
		for (let i = 0; i < 9; i++) {
			if (this.voices[i].on && this.voices[i].channel === ch && this.voices[i].note === note) {
				this.release(i);
				return;
			}
		}
	}

	private noteOn(ch: number, note: number, velocity: number): void {
		let idx = this.voices.findIndex((v) => !v.on);
		if (idx < 0) idx = this.voices.reduce((best, v, i) => (v.age < this.voices[best].age ? i : best), 0);
		if (this.voices[idx].on) this.release(idx);
		const drum = ch === 9;
		const patch = drum ? DRUM : FAMILY[this.program[ch] >> 3];
		this.load(idx, patch);
		const o = OP[idx];
		const mod = this.tl(patch.modTl, 127, ch);
		this.w(0x40 + o, mod);
		this.w(0x43 + o, this.tl(0, velocity, ch));
		const pitch = drum ? 36 + (note % 24) : note;
		this.voices[idx] = { channel: ch, note: pitch, age: ++this.age, on: true };
		this.keyOn(idx, pitch, ch, true);
	}
}

/** Anything that turns MIDI messages into audio on a chip: the OPL2 sound set, or the ROM-free MT-32 model */
export interface MidiSink {
	readonly chip: Chip;
	event(status: number, data1: number, data2: number): void;
}

/** Plays a Standard MIDI File or an XMI through a sink (the built-in OPL sound set by default) */
export class MidiPlayer implements RetroPlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[];
	readonly sampleRate: number;
	private readonly sink: MidiSink;
	private readonly isOpl: boolean;
	private idx = 0;
	private pos = 0;
	private ended = false;
	private readonly loop: boolean;

	constructor(
		readonly song: MidiSong,
		options: LoadOptions = {},
		sink?: MidiSink,
	) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.loop = options.loop ?? false;
		this.isOpl = !sink;
		this.sink = sink ?? new OplMidiSink(this.sampleRate);
		this.chips = [this.sink.chip];
		this.info = {
			format: 'midi',
			title: song.title,
			chips: [this.sink.chip.id],
			region: Region.NTSC,
			frameRate: 60,
			durationSeconds: song.duration,
			comment: sink ? `${sink.chip.name}` : 'generic OPL2 sound set',
		};
	}

	get finished(): boolean {
		return this.ended;
	}

	reset(): void {
		this.sink.chip.reset();
		if (this.isOpl) this.sink.chip.write(0x01, 0x20);
		this.idx = 0;
		this.pos = 0;
		this.ended = false;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): number {
		const ev = this.song.events;
		const endSample = Math.round((this.song.duration + 0.5) * this.sampleRate);
		let done = 0;
		while (done < count && !this.ended) {
			while (this.idx < ev.length && Math.round(ev[this.idx].time * this.sampleRate) <= this.pos) {
				const e = ev[this.idx++];
				this.sink.event(e.status, e.data1, e.data2);
			}
			if (this.idx >= ev.length && this.pos >= endSample) {
				if (this.loop) {
					this.reset();
					continue;
				}
				this.ended = true;
				break;
			}
			const next =
				this.idx < ev.length ? Math.min(Math.round(ev[this.idx].time * this.sampleRate), endSample) : endSample;
			const n = Math.min(count - done, Math.max(1, next - this.pos));
			this.sink.chip.render(left, right, start + done, n);
			this.pos += n;
			done += n;
		}
		return done;
	}

	setMuted(_chipIndex: number, channel: number, muted: boolean): void {
		this.sink.chip.setMuted(channel, muted);
	}
}

export function loadMidi(bytes: Uint8Array, options: LoadOptions = {}): MidiPlayer {
	return new MidiPlayer(parseSmf(isXmi(bytes) ? xmiToSmf(bytes) : bytes), options);
}

/** Play an MT-32 song (SMF or XMI) through the ROM-free LA model of `Mt32Synth`: works in a browser, needs no ROM */
export function loadMidiMt32(bytes: Uint8Array, options: LoadOptions = {}): MidiPlayer {
	const synth = new Mt32Synth(options.sampleRate ?? 44100);
	return new MidiPlayer(parseSmf(isXmi(bytes) ? xmiToSmf(bytes) : bytes), options, synth);
}

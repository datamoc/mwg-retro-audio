import type { MwaData } from './mwa.ts';
import { EventLog } from './opl-logs.ts';

/**
 * Creative Music File (`.cmf`, Sound Blaster 1.x): a MIDI-like track whose instruments are raw OPL2 patches stored in
 * the file. It is not General MIDI and cannot be rendered correctly through a MIDI synth: the patches are written to
 * the OPL registers and the notes are played on the 9 FM voices (or 6 + 5 percussion in rhythm mode), as the
 * Sound Blaster driver did. The file is compiled to timed OPL register writes (`MwaData`) and played by `MwaPlayer`.
 *
 * Supported: note on/off with velocity, program change, volume (CC 7) and expression (CC 11), pitch bend with a
 * settable range (CMF CC 0x68), the CMF controllers 0x66 (loop markers) and 0x67 (rhythm mode), tempo meta events.
 * Voices are allocated dynamically and the oldest note is stolen when all nine are busy.
 */

export function isCmf(b: Uint8Array): boolean {
	return b.length > 0x28 && String.fromCharCode(...b.subarray(0, 4)) === 'CTMF';
}

const MOD_OFFSET = [0, 1, 2, 8, 9, 10, 16, 17, 18];
const TIMEBASE = 44100;
const OPL_CLOCK = 3_579_545;
const OPL_RATE = OPL_CLOCK / 72;

interface Voice {
	channel: number;
	note: number;
	age: number;
	on: boolean;
	patch: number;
}

function freqToFnum(hz: number): { fnum: number; block: number } {
	for (let block = 0; block < 8; block++) {
		const fnum = Math.round((hz * 2 ** (20 - block)) / OPL_RATE);
		if (fnum < 1024) return { fnum, block };
	}
	return { fnum: 1023, block: 7 };
}

const text = (b: Uint8Array, o: number): string => {
	let s = '';
	while (o > 0 && o < b.length && b[o]) s += String.fromCharCode(b[o++]);
	return s;
};

/** Compile a CMF file to timed OPL2 register writes */
export function parseCmf(b: Uint8Array): MwaData {
	if (!isCmf(b)) throw new Error('not a CMF file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const version = v.getUint16(4, true);
	const insOffset = v.getUint16(6, true);
	const musicOffset = v.getUint16(8, true);
	const ticksPerQuarter = v.getUint16(10, true) || 48;
	const clockTicks = v.getUint16(12, true) || 96;
	const titleOff = v.getUint16(14, true);
	const authorOff = v.getUint16(16, true);
	const remarkOff = v.getUint16(18, true);
	const insCount = version >= 0x0101 ? v.getUint16(0x24, true) : b[0x24];
	let tempoBpm = version >= 0x0101 ? v.getUint16(0x26, true) || 120 : 120;
	const patches: Uint8Array[] = [];
	for (let i = 0; i < insCount; i++) patches.push(b.subarray(insOffset + i * 16, insOffset + i * 16 + 16));
	let usPerQuarter = 60_000_000 / tempoBpm;

	const log = new EventLog();
	const w = (reg: number, val: number): void => log.push(0, reg, val);
	w(0x01, 0x20);
	w(0xbd, 0xc0);

	const voices: Voice[] = Array.from({ length: 9 }, () => ({ channel: -1, note: -1, age: 0, on: false, patch: -1 }));
	const chProgram = new Array<number>(16).fill(0);
	const chVolume = new Array<number>(16).fill(127);
	const chExpression = new Array<number>(16).fill(127);
	const chBend = new Array<number>(16).fill(0);
	let bendRangeSemis = 2;
	let rhythm = false;
	let rhythmBits = 0;
	let loopStart = -1;
	let ageCounter = 0;
	let transpose = 0;

	const secondsPerTick = (): number => usPerQuarter / 1_000_000 / ticksPerQuarter;
	void clockTicks;

	const hzOf = (note: number, ch: number): number =>
		440 * 2 ** ((note + transpose - 69 + (chBend[ch] / 8192) * bendRangeSemis) / 12);

	const setTotalLevel = (voice: number, patch: Uint8Array, velocity: number, ch: number): void => {
		const mod = MOD_OFFSET[voice];
		const level = (velocity / 127) * (chVolume[ch] / 127) * (chExpression[ch] / 127);
		const att = level <= 0 ? 63 : Math.min(63, Math.round((-20 * Math.log10(level)) / 0.75));
		const additive = (patch[10] & 1) !== 0;
		const car = (patch[3] & 0xc0) | Math.min(63, (patch[3] & 63) + att);
		w(0x40 + mod + 3, car);
		w(0x40 + mod, additive ? (patch[2] & 0xc0) | Math.min(63, (patch[2] & 63) + att) : patch[2]);
	};

	const loadPatch = (voice: number, program: number): void => {
		const p = patches[program] ?? patches[0];
		if (!p) return;
		const mod = MOD_OFFSET[voice];
		w(0x20 + mod, p[0]);
		w(0x20 + mod + 3, p[1]);
		w(0x60 + mod, p[4]);
		w(0x60 + mod + 3, p[5]);
		w(0x80 + mod, p[6]);
		w(0x80 + mod + 3, p[7]);
		w(0xe0 + mod, p[8]);
		w(0xe0 + mod + 3, p[9]);
		w(0xc0 + voice, (p[10] & 0x0f) | 0x30);
		voices[voice].patch = program;
	};

	const keyOn = (voice: number, hz: number, on: boolean): void => {
		const { fnum, block } = freqToFnum(hz);
		w(0xa0 + voice, fnum & 255);
		w(0xb0 + voice, (on ? 0x20 : 0) | (block << 2) | (fnum >> 8));
	};

	const noteOn = (ch: number, note: number, vel: number): void => {
		if (rhythm && ch >= 11) {
			const bit = [0x10, 0x08, 0x04, 0x02, 0x01][ch - 11];
			const p = patches[chProgram[ch]] ?? patches[0];
			// drum voices live on fixed operators: BD both operators of voice 6, SD carrier of 7, TOM modulator of 8,
			// CYM carrier of 8, HH modulator of 7; the second number picks the modulator (0) or carrier (1) fields
			const ops: [number, number][] = [
				[
					[16, 0],
					[19, 1],
				],
				[[20, 1]],
				[[18, 0]],
				[[21, 1]],
				[[17, 0]],
			][ch - 11] as [number, number][];
			if (p) {
				for (const [op, carrier] of ops) {
					w(0x20 + op, p[carrier]);
					w(0x60 + op, p[4 + carrier]);
					w(0x80 + op, p[6 + carrier]);
					w(0xe0 + op, p[8 + carrier]);
				}
			}
			if (ch === 11) {
				const { fnum, block } = freqToFnum(hzOf(note, ch));
				w(0xa6, fnum & 255);
				w(0xb6, (block << 2) | (fnum >> 8));
			} else if (ch === 12) {
				w(0xa7, 0x50);
				w(0xb7, 0x09);
			} else if (ch === 13) {
				w(0xa8, 0x5f);
				w(0xb8, 0x05);
			}
			w(0xbd, 0xe0 | rhythmBits | bit);
			w(0xbd, 0xe0 | rhythmBits); // a single hit: the trigger bit is cleared again before the next one
			return;
		}
		// free voice, else the oldest one
		let idx = voices.findIndex((x) => !x.on);
		if (idx < 0) idx = voices.reduce((best, x, i) => (x.age < voices[best].age ? i : best), 0);
		const voice = voices[idx];
		if (voice.on) keyOn(idx, hzOf(voice.note, voice.channel), false);
		if (voice.patch !== chProgram[ch]) loadPatch(idx, chProgram[ch]);
		const patch = patches[chProgram[ch]] ?? patches[0];
		if (patch) setTotalLevel(idx, patch, vel, ch);
		voice.channel = ch;
		voice.note = note;
		voice.on = true;
		voice.age = ++ageCounter;
		keyOn(idx, hzOf(note, ch), true);
	};

	const noteOff = (ch: number, note: number): void => {
		if (rhythm && ch >= 11) return;
		const idx = voices.findIndex((x) => x.on && x.channel === ch && x.note === note);
		if (idx < 0) return;
		voices[idx].on = false;
		keyOn(idx, hzOf(note, ch), false);
	};

	// ---- MIDI-like event stream
	let p = musicOffset;
	let running = 0;
	let guard = 0;
	const varlen = (): number => {
		let x = 0;
		for (let i = 0; i < 4 && p < b.length; i++) {
			const c = b[p++];
			x = (x << 7) | (c & 0x7f);
			if (!(c & 0x80)) break;
		}
		return x;
	};
	let timeSec = 0;
	while (p < b.length && guard++ < 2_000_000) {
		const delta = varlen();
		timeSec += delta * secondsPerTick();
		log.time = timeSec * TIMEBASE;
		let st = b[p];
		if (st & 0x80) {
			p++;
			if (st < 0xf0) running = st;
		} else st = running;
		if (st === 0xff) {
			const type = b[p++];
			const len = varlen();
			if (type === 0x2f) break;
			if (type === 0x51 && len === 3) usPerQuarter = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
			p += len;
			continue;
		}
		if (st === 0xf0 || st === 0xf7) {
			p += varlen();
			continue;
		}
		const ch = st & 15;
		switch (st & 0xf0) {
			case 0x80:
				noteOff(ch, b[p]);
				p += 2;
				break;
			case 0x90:
				if (b[p + 1] === 0) noteOff(ch, b[p]);
				else noteOn(ch, b[p], b[p + 1]);
				p += 2;
				break;
			case 0xa0:
				p += 2;
				break;
			case 0xb0: {
				const cc = b[p];
				const val = b[p + 1];
				if (cc === 7) chVolume[ch] = val;
				else if (cc === 11) chExpression[ch] = val;
				else if (cc === 0x66) {
					if (val === 1 && loopStart < 0) loopStart = Math.round(timeSec * TIMEBASE);
				} else if (cc === 0x67) {
					rhythm = val !== 0;
					w(0xbd, 0xc0 | (rhythm ? 0x20 : 0));
				} else if (cc === 0x68) bendRangeSemis = Math.max(1, val / 4) || 2;
				else if (cc === 0x69) transpose = val - 64;
				p += 2;
				break;
			}
			case 0xc0:
				chProgram[ch] = b[p++];
				break;
			case 0xd0:
				p += 1;
				break;
			case 0xe0: {
				chBend[ch] = (b[p] | (b[p + 1] << 7)) - 8192;
				for (let i = 0; i < voices.length; i++) {
					if (voices[i].on && voices[i].channel === ch) keyOn(i, hzOf(voices[i].note, ch), true);
				}
				p += 2;
				break;
			}
			default:
				p++;
		}
	}
	// let the last notes decay a little before the end
	log.time += 0.5 * TIMEBASE;
	const data = log.build(
		[{ id: 'opl2', clock: OPL_CLOCK }],
		(ticksPerQuarter * (60_000_000 / usPerQuarter)) / 60,
		'',
	);
	data.title = text(b, titleOff);
	data.author = text(b, authorOff);
	data.comment = text(b, remarkOff);
	data.loopStart = loopStart;
	return data;
}

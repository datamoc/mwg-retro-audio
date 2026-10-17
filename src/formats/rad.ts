import type { MwaData } from './mwa.ts';
import { EventLog } from './opl-logs.ts';

/**
 * Reality ADlib Tracker (`.rad`), versions 1.0 and 2.1. The replayer of the format (public domain, by Shayde /
 * Reality) is ported here and run for the whole tune: the OPL register writes it makes are recorded as timed events
 * (`MwaData`: an OPL3 log for 2.1 tunes, which use up to 18 operators per channel and stereo panning, an OPL2 log for
 * 1.0 tunes) and replayed by `MwaPlayer`. The tune is cut when the order list starts to repeat; the repeat point
 * becomes the loop point.
 *
 * Supported: instruments with their riffs, order list with jumps, tracks, channel riffs and transposition, all
 * effects of the replayer (portamento, tone slide, volume slide, set volume, jump to line, set speed, instrument
 * multiplier / volume / feedback). MIDI instruments are ignored as in the reference replayer.
 */

const K_TRACK_LINES = 64;
const NOTE_SIZE = [0, 2, 1, 3, 1, 3, 2, 4];
const CHAN_OFFSETS3 = [0, 1, 2, 0x100, 0x101, 0x102, 6, 7, 8];
const CHN2_OFFSETS3 = [3, 4, 5, 0x103, 0x104, 0x105, 0x106, 0x107, 0x108];
const NOTE_FREQ = [0x16b, 0x181, 0x198, 0x1b0, 0x1ca, 0x1e5, 0x202, 0x220, 0x241, 0x263, 0x287, 0x2ae];
const OP_OFFSETS2 = [
	[0x003, 0x000],
	[0x004, 0x001],
	[0x005, 0x002],
	[0x00b, 0x008],
	[0x00c, 0x009],
	[0x00d, 0x00a],
	[0x013, 0x010],
	[0x014, 0x011],
	[0x015, 0x012],
];
const OP_OFFSETS3 = [
	[0x00b, 0x008, 0x003, 0x000],
	[0x00c, 0x009, 0x004, 0x001],
	[0x00d, 0x00a, 0x005, 0x002],
	[0x10b, 0x108, 0x103, 0x100],
	[0x10c, 0x109, 0x104, 0x101],
	[0x10d, 0x10a, 0x105, 0x102],
	[0x113, 0x110, 0x013, 0x010],
	[0x114, 0x111, 0x014, 0x011],
	[0x115, 0x112, 0x015, 0x012],
];
const ALG_CARRIERS = [
	[true, false, false, false],
	[true, true, false, false],
	[true, false, false, false],
	[true, false, false, true],
	[true, false, true, false],
	[true, false, true, true],
	[true, true, true, true],
];

const CM_PORTAMENTO_UP = 0x1;
const CM_PORTAMENTO_DWN = 0x2;
const CM_TONE_SLIDE = 0x3;
const CM_TONE_VOL_SLIDE = 0x5;
const CM_VOL_SLIDE = 0xa;
const CM_SET_VOL = 0xc;
const CM_JUMP_TO_LINE = 0xd;
const CM_SET_SPEED = 0xf;
const CM_IGNORE = 'I'.charCodeAt(0) - 55;
const CM_MULTIPLIER = 'M'.charCodeAt(0) - 55;
const CM_RIFF = 'R'.charCodeAt(0) - 55;
const CM_TRANSPOSE = 'T'.charCodeAt(0) - 55;
const CM_FEEDBACK = 'U'.charCodeAt(0) - 55;
const CM_VOLUME = 'V'.charCodeAt(0) - 55;

const F_KEY_ON = 1;
const F_KEY_OFF = 2;
const F_KEYED_ON = 4;

type Source = 'none' | 'riff' | 'iriff';

interface Instrument {
	feedback: [number, number];
	panning: [number, number];
	algorithm: number;
	detune: number;
	volume: number;
	riffSpeed: number;
	riff: number;
	operators: number[][];
	name: string;
}

interface Effects {
	portSlide: number;
	volSlide: number;
	toneSlideFreq: number;
	toneSlideOct: number;
	toneSlideSpeed: number;
	toneSlideDir: number;
}

interface Riff {
	fx: Effects;
	track: number;
	trackStart: number;
	line: number;
	speed: number;
	speedCnt: number;
	transposeOctave: number;
	transposeNote: number;
	lastInstrument: number;
	updated: boolean;
}

interface Channel {
	lastInstrument: number;
	instrument: Instrument | null;
	volume: number;
	detuneA: number;
	detuneB: number;
	keyFlags: number;
	currFreq: number;
	currOctave: number;
	fx: Effects;
	riff: Riff;
	iriff: Riff;
}

const newFx = (): Effects => ({
	portSlide: 0,
	volSlide: 0,
	toneSlideFreq: 0,
	toneSlideOct: 0,
	toneSlideSpeed: 0,
	toneSlideDir: 0,
});
const newRiff = (): Riff => ({
	fx: newFx(),
	track: -1,
	trackStart: -1,
	line: 0,
	speed: 0,
	speedCnt: 0,
	transposeOctave: 0,
	transposeNote: 0,
	lastInstrument: 0,
	updated: false,
});
const newChannel = (): Channel => ({
	lastInstrument: 0,
	instrument: null,
	volume: 0,
	detuneA: 0,
	detuneB: 0,
	keyFlags: 0,
	currFreq: 0,
	currOctave: 0,
	fx: newFx(),
	riff: newRiff(),
	iriff: newRiff(),
});
const newInstrument = (): Instrument => ({
	feedback: [0, 0],
	panning: [0, 0],
	algorithm: 0,
	detune: 0,
	volume: 0,
	riffSpeed: 0,
	riff: -1,
	operators: Array.from({ length: 4 }, () => [0, 0, 0, 0, 0]),
	name: '',
});

export function isRad(b: Uint8Array): boolean {
	return (
		b.length > 17 &&
		String.fromCharCode(...b.subarray(0, 16)) === 'RAD by REALiTY!!' &&
		(b[16] === 0x10 || b[16] === 0x21)
	);
}

class RadPlayer {
	private readonly d: Uint8Array;
	readonly version: number;
	private readonly useOpl3: boolean;
	hertz = 50;
	description = '';
	private readonly instruments: Instrument[] = Array.from({ length: 127 }, newInstrument);
	private readonly channels: Channel[] = Array.from({ length: 9 }, newChannel);
	private orderList = 0;
	private orderListSize = 0;
	private readonly tracks: number[] = new Array(100).fill(-1);
	private readonly riffs: number[][] = Array.from({ length: 10 }, () => new Array(9).fill(-1));
	private track = -1;
	private speed = 6;
	private speedCnt = 1;
	private order = 0;
	private line = 0;
	private entrances = 0;
	private masterVol = 64;
	private lineJump = -1;
	private readonly regs = new Uint8Array(512).fill(255);
	private noteNum = 0;
	private octaveNum = 0;
	private instNum = 0;
	private effectNum = 0;
	private param = 0;
	repeating = false;
	/** time (in updates) at which each order was first reached, to turn the repeat into a loop point */
	readonly orderTime = new Map<number, number>();
	repeatOrder = -1;
	playTime = 0;
	private readonly orderMap = new Set<number>();

	constructor(
		data: Uint8Array,
		private readonly out: (reg: number, value: number) => void,
	) {
		// some old tunes have a truncated final note: an extra zero byte keeps them playable
		this.d = new Uint8Array(data.length + 1);
		this.d.set(data);
		const d = this.d;
		this.version = d[0x10] >> 4;
		this.useOpl3 = this.version >= 2;
		let s = 0x11;
		const flags = d[s++];
		this.speed = flags & 0x1f;
		if (this.version >= 2 && flags & 0x20) {
			this.hertz = ((d[s] | (d[s + 1] << 8)) * 2) / 5;
			s += 2;
		}
		if (flags & 0x40) this.hertz = 18.2;
		if (this.version >= 2 || flags & 0x80) {
			let text = '';
			while (d[s]) {
				const c = d[s++];
				if (c >= 0x20) text += String.fromCharCode(c);
				else if (c === 1) text += '\n';
				else text += ' '.repeat(c);
			}
			s++;
			this.description = text;
		}
		for (;;) {
			const instNum = d[s++];
			if (instNum === 0) break;
			const inst = this.instruments[instNum - 1];
			if (this.version >= 2) {
				const nameLen = d[s++];
				inst.name = String.fromCharCode(...d.subarray(s, s + nameLen));
				s += nameLen;
				const alg = d[s++];
				inst.algorithm = alg & 7;
				inst.panning = [(alg >> 3) & 3, (alg >> 5) & 3];
				if (inst.algorithm < 7) {
					let b = d[s++];
					inst.feedback = [b & 15, b >> 4];
					b = d[s++];
					inst.detune = b >> 4;
					inst.riffSpeed = b & 15;
					inst.volume = d[s++];
					for (let i = 0; i < 4; i++) for (let j = 0; j < 5; j++) inst.operators[i][j] = d[s++];
				} else s += 6;
				if (alg & 0x80) {
					const size = d[s] | (d[s + 1] << 8);
					s += 2;
					inst.riff = s;
					s += size;
				} else inst.riff = -1;
			} else {
				inst.algorithm = d[s + 8] & 1;
				inst.feedback = [(d[s + 8] >> 1) & 7, 0];
				inst.volume = 64;
				const ops = inst.operators;
				ops[0][0] = d[s];
				ops[1][0] = d[s + 1];
				ops[0][1] = d[s + 2];
				ops[1][1] = d[s + 3];
				ops[0][2] = d[s + 4];
				ops[1][2] = d[s + 5];
				ops[0][3] = d[s + 6];
				ops[1][3] = d[s + 7];
				ops[0][4] = d[s + 9];
				ops[1][4] = d[s + 10];
				inst.riff = -1;
				s += 11;
			}
		}
		this.orderListSize = d[s++];
		this.orderList = s;
		s += this.orderListSize;
		if (this.version >= 2) {
			for (;;) {
				const t = d[s++];
				if (t >= 100) break;
				const size = d[s] | (d[s + 1] << 8);
				s += 2;
				this.tracks[t] = s;
				s += size;
			}
			for (;;) {
				const id = d[s++];
				const riffNum = id >> 4;
				const chan = id & 15;
				if (riffNum >= 10 || chan > 9 || s >= d.length) break;
				const size = d[s] | (d[s + 1] << 8);
				s += 2;
				this.riffs[riffNum][chan - 1] = s;
				s += size;
			}
		} else {
			for (let i = 0; i < 32; i++) {
				const pos = d[s] | (d[s + 1] << 8);
				s += 2;
				if (pos) this.tracks[i] = pos;
			}
		}
		this.stop();
	}

	private setOpl3(reg: number, val: number): void {
		this.regs[reg] = val;
		this.out(reg, val);
	}
	private getOpl3(reg: number): number {
		return this.regs[reg];
	}

	stop(): void {
		for (let reg = 0x20; reg < 0xf6; reg++) {
			const val = reg >= 0x60 && reg < 0xa0 ? 0xff : 0;
			this.setOpl3(reg, val);
			this.setOpl3(reg + 0x100, val);
		}
		this.setOpl3(1, 0x20);
		this.setOpl3(8, 0);
		this.setOpl3(0xbd, 0);
		this.setOpl3(0x104, 0);
		this.setOpl3(0x105, 1);
		this.playTime = 0;
		this.repeating = false;
		this.orderMap.clear();
		this.speedCnt = 1;
		this.order = 0;
		this.track = this.getTrack();
		this.line = 0;
		this.entrances = 0;
		this.masterVol = 64;
		for (const c of this.channels) {
			c.lastInstrument = 0;
			c.instrument = null;
			c.volume = 0;
			c.detuneA = 0;
			c.detuneB = 0;
			c.keyFlags = 0;
			c.riff.speedCnt = 0;
			c.iriff.speedCnt = 0;
		}
	}

	update(): boolean {
		for (let i = 0; i < 9; i++) {
			const c = this.channels[i];
			this.tickRiff(i, c.iriff, false);
			this.tickRiff(i, c.riff, true);
		}
		this.playLine();
		for (let i = 0; i < 9; i++) {
			const c = this.channels[i];
			this.continueFx(i, c.iriff.fx);
			this.continueFx(i, c.riff.fx);
			this.continueFx(i, c.fx);
		}
		this.playTime++;
		return this.repeating;
	}

	/** unpack one note at `s`; returns [next offset, last note of the line] */
	private unpackNote(s: number, lastInstrument: { v: number }): [number, boolean] {
		const d = this.d;
		const chanid = d[s++];
		this.instNum = 0;
		this.effectNum = 0;
		this.param = 0;
		let note = 0;
		if (this.version >= 2) {
			if (chanid & 0x40) {
				const n = d[s++];
				note = n & 0x7f;
				if (n & 0x80) this.instNum = lastInstrument.v;
			}
			if (chanid & 0x20) {
				this.instNum = d[s++];
				lastInstrument.v = this.instNum;
			}
			if (chanid & 0x10) {
				this.effectNum = d[s++];
				this.param = d[s++];
			}
		} else {
			let n = d[s++];
			note = n & 0x7f;
			if (n & 0x80) this.instNum = 16;
			n = d[s++];
			this.instNum |= n >> 4;
			if (this.instNum) lastInstrument.v = this.instNum;
			this.effectNum = n & 0xf;
			if (this.effectNum) this.param = d[s++];
		}
		this.noteNum = note & 15;
		this.octaveNum = note >> 4;
		return [s, (chanid & 0x80) !== 0];
	}

	private getTrack(): number {
		if (this.order >= this.orderListSize) this.order = 0;
		let trackNum = this.d[this.orderList + this.order];
		if (trackNum & 0x80) {
			this.order = trackNum & 0x7f;
			trackNum = this.d[this.orderList + this.order] & 0x7f;
		}
		if (this.order < 128) {
			if (this.orderMap.has(this.order)) {
				if (!this.repeating) this.repeatOrder = this.order;
				this.repeating = true;
			} else {
				this.orderMap.add(this.order);
				this.orderTime.set(this.order, this.playTime);
			}
		}
		return this.tracks[trackNum];
	}

	private skipToLine(trk: number, lineNum: number, chanRiff: boolean): number {
		const d = this.d;
		for (;;) {
			if (trk < 0) return -1;
			const lineId = d[trk];
			if ((lineId & 0x7f) >= lineNum) return trk;
			if (lineId & 0x80) break;
			trk++;
			let chanId: number;
			do {
				chanId = d[trk++];
				if (this.version >= 2) trk += NOTE_SIZE[(chanId >> 4) & 7];
				else if (d[trk + 1] & 0xf) trk += 3;
				else trk += 2;
			} while (!(chanId & 0x80) && !chanRiff);
		}
		return -1;
	}

	private playLine(): void {
		if (--this.speedCnt > 0) return;
		this.speedCnt = this.speed;
		for (const c of this.channels) this.resetFx(c.fx);
		this.lineJump = -1;
		let trk = this.track;
		if (trk >= 0 && (this.d[trk] & 0x7f) <= this.line) {
			const lineId = this.d[trk++];
			let last: boolean;
			do {
				const channum = this.d[trk] & 15;
				const chan = this.channels[channum];
				const li = { v: chan.lastInstrument };
				[trk, last] = this.unpackNote(trk, li);
				chan.lastInstrument = li.v;
				this.playNote(
					channum,
					this.noteNum,
					this.octaveNum,
					this.instNum,
					this.effectNum,
					this.param,
					'none',
					0,
				);
			} while (!last);
			if (lineId & 0x80) trk = -1;
			this.track = trk;
		}
		this.line++;
		if (this.line >= K_TRACK_LINES || this.lineJump >= 0) {
			this.line = this.lineJump >= 0 ? this.lineJump : 0;
			this.order++;
			this.track = this.getTrack();
			if (this.line > 0) this.track = this.skipToLine(this.track, this.line, false);
		}
	}

	private playNote(
		channum: number,
		notenum: number,
		octave: number,
		instnum: number,
		cmd: number,
		param: number,
		src: Source,
		op: number,
	): void {
		const chan = this.channels[channum];
		if (this.entrances >= 8) return;
		this.entrances++;
		const fx = src === 'riff' ? chan.riff.fx : src === 'iriff' ? chan.iriff.fx : chan.fx;
		let transposing = false;
		let doToneSlide = false;
		if (cmd === CM_TONE_SLIDE) {
			if (notenum > 0 && notenum <= 12) {
				fx.toneSlideOct = octave;
				fx.toneSlideFreq = NOTE_FREQ[notenum - 1];
			}
			doToneSlide = true;
		}
		if (!doToneSlide) {
			if (instnum > 0) {
				const oldinst = chan.instrument;
				const inst = this.instruments[instnum - 1];
				chan.instrument = inst;
				if (inst.algorithm < 7) {
					this.loadInstrumentOpl3(channum);
					chan.keyFlags |= F_KEY_OFF | F_KEY_ON;
					this.resetFx(chan.iriff.fx);
					if (src !== 'iriff' || inst !== oldinst) {
						if (inst.riff >= 0 && inst.riffSpeed > 0) {
							chan.iriff.track = chan.iriff.trackStart = inst.riff;
							chan.iriff.line = 0;
							chan.iriff.speed = inst.riffSpeed;
							chan.iriff.lastInstrument = 0;
							if (notenum >= 1 && notenum <= 12) {
								chan.iriff.transposeOctave = octave;
								chan.iriff.transposeNote = notenum;
								transposing = true;
							} else {
								chan.iriff.transposeOctave = 3;
								chan.iriff.transposeNote = 12;
							}
							chan.iriff.speedCnt = 1;
							this.tickRiff(channum, chan.iriff, false);
						} else chan.iriff.speedCnt = 0;
					}
				} else chan.instrument = null;
			}
			if (cmd === CM_RIFF || cmd === CM_TRANSPOSE) {
				this.resetFx(chan.riff.fx);
				const p0 = Math.floor(param / 10);
				const p1 = param % 10;
				chan.riff.track = p1 > 0 ? (this.riffs[p0]?.[p1 - 1] ?? -1) : -1;
				if (chan.riff.track >= 0) {
					chan.riff.trackStart = chan.riff.track;
					chan.riff.line = 0;
					chan.riff.speed = this.speed;
					chan.riff.lastInstrument = 0;
					if (cmd === CM_TRANSPOSE && notenum >= 1 && notenum <= 12) {
						chan.riff.transposeOctave = octave;
						chan.riff.transposeNote = notenum;
						transposing = true;
					} else {
						chan.riff.transposeOctave = 3;
						chan.riff.transposeNote = 12;
					}
					chan.riff.speedCnt = 1;
					this.tickRiff(channum, chan.riff, true);
				} else chan.riff.speedCnt = 0;
			}
			if (!transposing && notenum > 0) {
				if (notenum === 15) chan.keyFlags |= F_KEY_OFF;
				if (!chan.instrument || chan.instrument.algorithm < 7) this.playNoteOpl3(channum, octave, notenum);
			}
		}
		if (!doToneSlide) {
			switch (cmd) {
				case CM_SET_VOL:
					this.setVolume(channum, param);
					break;
				case CM_SET_SPEED:
					if (src === 'none') {
						this.speed = param;
						this.speedCnt = param;
					} else if (src === 'riff') {
						chan.riff.speed = param;
						chan.riff.speedCnt = param;
					} else {
						chan.iriff.speed = param;
						chan.iriff.speedCnt = param;
					}
					break;
				case CM_PORTAMENTO_UP:
					fx.portSlide = param;
					break;
				case CM_PORTAMENTO_DWN:
					fx.portSlide = -param;
					break;
				case CM_TONE_VOL_SLIDE:
				case CM_VOL_SLIDE: {
					let val = (param << 24) >> 24;
					if (val >= 50) val = -(val - 50);
					fx.volSlide = val;
					if (cmd !== CM_TONE_VOL_SLIDE) break;
					doToneSlide = true;
					break;
				}
				case CM_JUMP_TO_LINE:
					if (param < K_TRACK_LINES && src === 'none') this.lineJump = param;
					break;
				case CM_MULTIPLIER:
					if (src === 'iriff') this.loadInstMultiplierOpl3(channum, op, param);
					break;
				case CM_VOLUME:
					if (src === 'iriff') this.loadInstVolumeOpl3(channum, op, param);
					break;
				case CM_FEEDBACK:
					if (src === 'iriff') this.loadInstFeedbackOpl3(channum, Math.floor(param / 10), param % 10);
					break;
			}
		}
		if (doToneSlide) {
			if (param) fx.toneSlideSpeed = param;
			this.getSlideDir(channum, fx);
		}
		this.entrances--;
	}

	private loadInstrumentOpl3(channum: number): void {
		const chan = this.channels[channum];
		const inst = chan.instrument;
		if (!inst) return;
		const alg = inst.algorithm;
		chan.volume = inst.volume;
		chan.detuneA = (inst.detune + 1) >> 1;
		chan.detuneB = inst.detune >> 1;
		if (this.useOpl3 && channum < 6) {
			const mask = 1 << channum;
			this.setOpl3(0x104, (this.getOpl3(0x104) & ~mask) | (alg === 2 || alg === 3 ? mask : 0));
		}
		if (this.useOpl3) {
			this.setOpl3(
				0xc0 + CHAN_OFFSETS3[channum],
				((inst.panning[1] ^ 3) << 4) | (inst.feedback[1] << 1) | (alg === 3 || alg === 5 || alg === 6 ? 1 : 0),
			);
			this.setOpl3(
				0xc0 + CHN2_OFFSETS3[channum],
				((inst.panning[0] ^ 3) << 4) | (inst.feedback[0] << 1) | (alg === 1 || alg === 6 ? 1 : 0),
			);
		} else {
			this.setOpl3(0xc0 + channum, ((inst.panning[0] ^ 3) << 4) | (inst.feedback[0] << 1) | (alg === 1 ? 1 : 0));
		}
		const blank = [0, 0x3f, 0, 0xf0, 0];
		for (let i = 0; i < (this.useOpl3 ? 4 : 2); i++) {
			const op = alg < 2 && i >= 2 ? blank : inst.operators[i];
			const reg = this.useOpl3 ? OP_OFFSETS3[channum][i] : OP_OFFSETS2[channum][i];
			let vol = ~op[1] & 0x3f;
			if (ALG_CARRIERS[alg][i]) {
				vol = Math.floor((vol * inst.volume) / 64);
				vol = Math.floor((vol * this.masterVol) / 64);
			}
			this.setOpl3(reg + 0x20, op[0]);
			this.setOpl3(reg + 0x40, (op[1] & 0xc0) | ((vol ^ 0x3f) & 0x3f));
			this.setOpl3(reg + 0x60, op[2]);
			this.setOpl3(reg + 0x80, op[3]);
			this.setOpl3(reg + 0xe0, op[4]);
		}
	}

	private playNoteOpl3(channum: number, octave: number, note: number): void {
		const chan = this.channels[channum];
		const o1 = this.useOpl3 ? CHAN_OFFSETS3[channum] : 0;
		const o2 = this.useOpl3 ? CHN2_OFFSETS3[channum] : channum;
		if (chan.keyFlags & F_KEY_OFF) {
			chan.keyFlags &= ~(F_KEY_OFF | F_KEYED_ON);
			if (this.useOpl3) this.setOpl3(0xb0 + o1, this.getOpl3(0xb0 + o1) & ~0x20);
			this.setOpl3(0xb0 + o2, this.getOpl3(0xb0 + o2) & ~0x20);
		}
		if (note > 12) return;
		const op4 = this.useOpl3 && !!chan.instrument && chan.instrument.algorithm >= 2;
		let freq = NOTE_FREQ[note - 1];
		let frq2 = freq;
		chan.currFreq = freq;
		chan.currOctave = octave;
		freq += chan.detuneA;
		frq2 -= chan.detuneB;
		if (op4) this.setOpl3(0xa0 + o1, frq2 & 0xff);
		this.setOpl3(0xa0 + o2, freq & 0xff);
		if (chan.keyFlags & F_KEY_ON) chan.keyFlags = (chan.keyFlags & ~F_KEY_ON) | F_KEYED_ON;
		const key = chan.keyFlags & F_KEYED_ON ? 0x20 : 0;
		if (op4) this.setOpl3(0xb0 + o1, ((frq2 >> 8) & 0xff) | (octave << 2) | key);
		else if (this.useOpl3) this.setOpl3(0xb0 + o1, 0);
		this.setOpl3(0xb0 + o2, ((freq >> 8) & 0xff) | (octave << 2) | key);
	}

	private resetFx(fx: Effects): void {
		fx.portSlide = 0;
		fx.volSlide = 0;
		fx.toneSlideDir = 0;
	}

	private tickRiff(channum: number, riff: Riff, chanRiff: boolean): void {
		const d = this.d;
		riff.updated = true;
		if (riff.speedCnt === 0) {
			this.resetFx(riff.fx);
			return;
		}
		if (--riff.speedCnt > 0) return;
		riff.speedCnt = riff.speed;
		const line = riff.line++;
		if (riff.line >= K_TRACK_LINES) riff.speedCnt = 0;
		this.resetFx(riff.fx);
		let trk = riff.track;
		if (trk >= 0 && (d[trk] & 0x7f) === line) {
			const lineId = d[trk++];
			riff.updated = false;
			const li = { v: riff.lastInstrument };
			if (chanRiff) {
				[trk] = this.unpackNote(trk, li);
				riff.lastInstrument = li.v;
				this.transpose(riff.transposeNote, riff.transposeOctave);
				this.playNote(
					channum,
					this.noteNum,
					this.octaveNum,
					this.instNum,
					this.effectNum,
					this.param,
					'riff',
					0,
				);
			} else {
				let last: boolean;
				do {
					const col = d[trk] & 15;
					[trk, last] = this.unpackNote(trk, li);
					riff.lastInstrument = li.v;
					if (this.effectNum !== CM_IGNORE) this.transpose(riff.transposeNote, riff.transposeOctave);
					this.playNote(
						channum,
						this.noteNum,
						this.octaveNum,
						this.instNum,
						this.effectNum,
						this.param,
						'iriff',
						col > 0 ? (col - 1) & 3 : 0,
					);
				} while (!last);
			}
			if (riff.updated) return;
			riff.updated = true;
			if (lineId & 0x80) trk = -1;
			riff.track = trk;
		}
		if (trk < 0 || (d[trk++] & 0x7f) !== riff.line) return;
		const dummy = { v: 0 };
		this.unpackNote(trk, dummy);
		if (this.effectNum === CM_JUMP_TO_LINE && this.param < K_TRACK_LINES) {
			riff.line = this.param;
			riff.track = this.skipToLine(riff.trackStart, this.param, chanRiff);
		}
	}

	private continueFx(channum: number, fx: Effects): void {
		const chan = this.channels[channum];
		if (fx.portSlide) this.portamento(channum, fx, fx.portSlide, false);
		if (fx.volSlide) {
			let vol = (chan.volume << 24) >> 24;
			vol -= fx.volSlide;
			if (vol < 0) vol = 0;
			this.setVolume(channum, vol);
		}
		if (fx.toneSlideDir) this.portamento(channum, fx, fx.toneSlideDir, true);
	}

	private setVolume(channum: number, volIn: number): void {
		const chan = this.channels[channum];
		let vol = Math.min(volIn & 255, 64);
		chan.volume = vol;
		vol = Math.floor((vol * this.masterVol) / 64);
		const inst = chan.instrument;
		if (!inst) return;
		const alg = inst.algorithm;
		for (let i = 0; i < 4; i++) {
			if (!ALG_CARRIERS[alg][i]) continue;
			const op = inst.operators[i];
			const opvol = Math.floor((((op[1] & 63) ^ 63) * vol) / 64);
			const reg = 0x40 + (this.useOpl3 ? OP_OFFSETS3[channum][i] : OP_OFFSETS2[channum][i]);
			this.setOpl3(reg, (this.getOpl3(reg) & 0xc0) | ((opvol ^ 0x3f) & 0x3f));
		}
	}

	private getSlideDir(channum: number, fx: Effects): void {
		const chan = this.channels[channum];
		let speed = (fx.toneSlideSpeed << 24) >> 24;
		if (speed > 0) {
			const oct = fx.toneSlideOct;
			const freq = fx.toneSlideFreq;
			const oldfreq = chan.currFreq;
			const oldoct = chan.currOctave;
			if (oldoct > oct) speed = -speed;
			else if (oldoct === oct) {
				if (oldfreq > freq) speed = -speed;
				else if (oldfreq === freq) speed = 0;
			}
		}
		fx.toneSlideDir = speed;
	}

	private loadInstMultiplierOpl3(channum: number, op: number, mult: number): void {
		const reg = 0x20 + OP_OFFSETS3[channum][op];
		this.setOpl3(reg, (this.getOpl3(reg) & 0xf0) | (mult & 15));
	}
	private loadInstVolumeOpl3(channum: number, op: number, vol: number): void {
		const reg = 0x40 + OP_OFFSETS3[channum][op];
		this.setOpl3(reg, (this.getOpl3(reg) & 0xc0) | ((vol & 0x3f) ^ 0x3f));
	}
	private loadInstFeedbackOpl3(channum: number, which: number, fb: number): void {
		if (which === 0) {
			const reg = 0xc0 + CHN2_OFFSETS3[channum];
			this.setOpl3(reg, (this.getOpl3(reg) & 0x31) | ((fb & 7) << 1));
		} else if (which === 1) {
			const reg = 0xc0 + CHAN_OFFSETS3[channum];
			this.setOpl3(reg, (this.getOpl3(reg) & 0x31) | ((fb & 7) << 1));
		}
	}

	private portamento(channum: number, fx: Effects, amount: number, toneslide: boolean): void {
		const chan = this.channels[channum];
		let freq = chan.currFreq;
		let oct = chan.currOctave;
		freq += amount;
		if (freq < 0x156) {
			if (oct > 0) {
				oct--;
				freq += 0x2ae - 0x156;
			} else freq = 0x156;
		} else if (freq > 0x2ae) {
			if (oct < 7) {
				oct++;
				freq -= 0x2ae - 0x156;
			} else freq = 0x2ae;
		}
		if (toneslide) {
			if (amount >= 0) {
				if (oct > fx.toneSlideOct || (oct === fx.toneSlideOct && freq >= fx.toneSlideFreq)) {
					freq = fx.toneSlideFreq;
					oct = fx.toneSlideOct;
				}
			} else if (oct < fx.toneSlideOct || (oct === fx.toneSlideOct && freq <= fx.toneSlideFreq)) {
				freq = fx.toneSlideFreq;
				oct = fx.toneSlideOct;
			}
		}
		chan.currFreq = freq;
		chan.currOctave = oct;
		const frq2 = freq - chan.detuneB;
		freq += chan.detuneA;
		let off = this.useOpl3 ? CHN2_OFFSETS3[channum] : channum;
		this.setOpl3(0xa0 + off, freq & 0xff);
		this.setOpl3(0xb0 + off, ((freq >> 8) & 3) | (oct << 2) | (this.getOpl3(0xb0 + off) & 0xe0));
		if (this.useOpl3) {
			off = CHAN_OFFSETS3[channum];
			this.setOpl3(0xa0 + off, frq2 & 0xff);
			this.setOpl3(0xb0 + off, ((frq2 >> 8) & 3) | (oct << 2) | (this.getOpl3(0xb0 + off) & 0xe0));
		}
	}

	private transpose(note: number, octave: number): void {
		if (this.noteNum >= 1 && this.noteNum <= 12) {
			const toct = octave - 3;
			if (toct !== 0) {
				this.octaveNum += toct;
				if (this.octaveNum < 0) this.octaveNum = 0;
				else if (this.octaveNum > 7) this.octaveNum = 7;
			}
			const tnot = note - 12;
			if (tnot !== 0) {
				this.noteNum += tnot;
				if (this.noteNum < 1) {
					this.noteNum += 12;
					if (this.octaveNum > 0) this.octaveNum--;
					else this.noteNum = 1;
				}
			}
		}
	}
}

/** Run a `.rad` tune to its first repeat and return the OPL register log */
export function parseRad(b: Uint8Array, options: { maxSeconds?: number } = {}): MwaData {
	if (!isRad(b)) throw new Error('not a RAD file (version 1.0 or 2.1 expected)');
	const log = new EventLog();
	const timebase = 44100;
	const player = new RadPlayer(b, (reg, val) => log.push(0, reg, val));
	const maxTicks = Math.ceil((options.maxSeconds ?? 600) * player.hertz);
	let ticks = 0;
	// the writes of the constructor (reset of the chip) happen at time 0
	for (; ticks < maxTicks; ticks++) {
		log.time = (ticks / player.hertz) * timebase;
		if (player.update()) {
			ticks++;
			break;
		}
	}
	log.time = (ticks / player.hertz) * timebase;
	const chip = player.version >= 2 ? { id: 'opl3', clock: 14_318_180 } : { id: 'opl2', clock: 3_579_545 };
	const data = log.build([chip], player.hertz, player.description);
	data.comment = player.description;
	if (player.repeating) {
		const at = player.orderTime.get(player.repeatOrder);
		if (at !== undefined) data.loopStart = Math.round((at / player.hertz) * timebase);
	}
	data.length = Math.round(log.time);
	return data;
}

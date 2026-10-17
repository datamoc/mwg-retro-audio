import { SincResampler } from '../driver/Resampler.ts';
import type { Dx7Voice } from '../formats/dx7.ts';
import type { Chip, ChipOptions } from './Chip.ts';
import { LOGSIN } from './fm.ts';

/**
 * Yamaha DX7 six operator FM engine (voices of the DX7, TX7, TX816, DX9 family).
 *
 * Numerical laws: the 32 algorithms, the operator envelope (4 rate / 4 level stages, the exponential attack, rate
 * scaling, the output level table, level scaling by break point and curve, velocity sensitivity), the frequency
 * tables (coarse ratio, fine, detune, fixed frequency), the pitch envelope table and the feedback law come from the
 * numerical description published with the "music-synthesizer-for-android" project (Apache License 2.0, Copyright
 * 2012 Google Inc.), the base of Dexed. The engine around them is written here.
 *
 * What it does beyond a host-rate software synth:
 * - it runs at the **native rate of the machine, 49 096 Hz**, with the envelope blocks of 64 samples at that rate, and
 *   hands the audio to a windowed-sinc resampler: envelope times, LFO speeds and pitch envelopes are exactly the
 *   same whatever the output rate, and the audio that leaves the engine is band-limited instead of being generated
 *   directly at 44.1 / 48 kHz (`nativeRate: false` gives that behaviour for comparison);
 * - `accuracy: 'authentic'` computes every operator through the 12 bit logarithmic sine and exponential tables of the
 *   chip family (10 bit phase, 1/256 octave steps) with integer amplitudes, which brings the quantisation grit of the
 *   hardware; `'clean'` (default) uses double precision sines;
 * - the LFO has all six waveforms, delay with fade-in, key sync and the amplitude modulation sensitivity of each
 *   operator; the controllers are modelled: pitch bend with its range, modulation wheel, aftertouch and breath
 *   controller with their ranges and assignments (pitch, amplitude, EG bias), sustain pedal, operator on/off switches,
 *   transposition.
 *
 * Approximations: the amplitude modulation depth law and the LFO delay ramp are fitted, not measured on hardware;
 * portamento / glissando and the DX7II extensions are not implemented.
 *
 * Voices are the `Dx7Voice` of a SysEx dump (`parseDx7Bank`, `parseDx7Single`). Chip interface: `write(note, velocity)`
 * plays (velocity 0 = key off), `write(128, n)` selects a voice of the loaded bank, 129 pitch bend (0-16383), 130
 * modulation wheel, 131 aftertouch, 132 breath (0-127), 133 sustain pedal (>= 64 = down).
 */

// bit layout of one algorithm entry: 0-1 output bus, 2 add, 4-5 input bus, 6 feedback in, 7 feedback out
const ALGORITHMS: number[][] = [
	[0xc1, 0x11, 0x11, 0x14, 0x01, 0x14],
	[0x01, 0x11, 0x11, 0x14, 0xc1, 0x14],
	[0xc1, 0x11, 0x14, 0x01, 0x11, 0x14],
	[0x41, 0x11, 0x94, 0x01, 0x11, 0x14],
	[0xc1, 0x14, 0x01, 0x14, 0x01, 0x14],
	[0x41, 0x94, 0x01, 0x14, 0x01, 0x14],
	[0xc1, 0x11, 0x05, 0x14, 0x01, 0x14],
	[0x01, 0x11, 0xc5, 0x14, 0x01, 0x14],
	[0x01, 0x11, 0x05, 0x14, 0xc1, 0x14],
	[0x01, 0x05, 0x14, 0xc1, 0x11, 0x14],
	[0xc1, 0x05, 0x14, 0x01, 0x11, 0x14],
	[0x01, 0x05, 0x05, 0x14, 0xc1, 0x14],
	[0xc1, 0x05, 0x05, 0x14, 0x01, 0x14],
	[0xc1, 0x05, 0x11, 0x14, 0x01, 0x14],
	[0x01, 0x05, 0x11, 0x14, 0xc1, 0x14],
	[0xc1, 0x11, 0x02, 0x25, 0x05, 0x14],
	[0x01, 0x11, 0x02, 0x25, 0xc5, 0x14],
	[0x01, 0x11, 0x11, 0xc5, 0x05, 0x14],
	[0xc1, 0x14, 0x14, 0x01, 0x11, 0x14],
	[0x01, 0x05, 0x14, 0xc1, 0x14, 0x14],
	[0x01, 0x14, 0x14, 0xc1, 0x14, 0x14],
	[0xc1, 0x14, 0x14, 0x14, 0x01, 0x14],
	[0xc1, 0x14, 0x14, 0x01, 0x14, 0x04],
	[0xc1, 0x14, 0x14, 0x14, 0x04, 0x04],
	[0xc1, 0x14, 0x14, 0x04, 0x04, 0x04],
	[0xc1, 0x05, 0x14, 0x01, 0x14, 0x04],
	[0x01, 0x05, 0x14, 0xc1, 0x14, 0x04],
	[0x04, 0xc1, 0x11, 0x14, 0x01, 0x14],
	[0xc1, 0x14, 0x01, 0x14, 0x04, 0x04],
	[0x04, 0xc1, 0x11, 0x14, 0x04, 0x04],
	[0xc1, 0x14, 0x04, 0x04, 0x04, 0x04],
	[0xc4, 0x04, 0x04, 0x04, 0x04, 0x04],
];

/** number of carriers (operators that feed the output) of each algorithm */
export const DX7_CARRIERS: readonly number[] = ALGORITHMS.map((a) => a.filter((f) => (f & 3) === 0).length);

const LEVEL_LUT = [0, 5, 9, 13, 17, 20, 23, 25, 27, 29, 31, 33, 35, 37, 39, 41, 42, 43, 45, 46];
const COARSE_MUL = [
	-16777216, 0, 16777216, 26591258, 33554432, 38955489, 43368474, 47099600, 50331648, 53182516, 55732705, 58039632,
	60145690, 62083076, 63876816, 65546747, 67108864, 68576247, 69959732, 71268397, 72509921, 73690858, 74816848,
	75892776, 76922906, 77910978, 78860292, 79773775, 80654032, 81503396, 82323963, 83117622,
];
const VELOCITY_DATA = [
	0, 70, 86, 97, 106, 114, 121, 126, 132, 138, 142, 148, 152, 156, 160, 163, 166, 170, 173, 174, 178, 181, 184, 186,
	189, 190, 194, 196, 198, 200, 202, 205, 206, 209, 211, 214, 216, 218, 220, 222, 224, 225, 227, 229, 230, 232, 233,
	235, 237, 238, 240, 241, 242, 243, 244, 246, 246, 248, 249, 250, 251, 252, 253, 254,
];
const EXP_SCALE_DATA = [
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14, 16, 19, 23, 27, 33, 39, 47, 56, 66, 80, 94, 110, 126, 142, 158, 174, 190, 206,
	222, 238, 250,
];
const PITCH_RATE_TAB = [
	1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 16, 16, 17, 18, 18, 19,
	20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 31, 33, 34, 36, 37, 38, 39, 41, 42, 44, 46, 47, 49, 51, 53, 54, 56, 58, 60,
	62, 64, 66, 68, 70, 72, 74, 76, 79, 82, 85, 88, 91, 94, 98, 102, 106, 110, 115, 120, 125, 130, 135, 141, 147, 153,
	159, 165, 171, 178, 185, 193, 202, 211, 232, 243, 254, 255,
];
const PITCH_TAB = [
	-128, -116, -104, -95, -85, -76, -68, -61, -56, -52, -49, -46, -43, -41, -39, -37, -35, -33, -32, -31, -30, -29,
	-28, -27, -26, -25, -24, -23, -22, -21, -20, -19, -18, -17, -16, -15, -14, -13, -12, -11, -10, -9, -8, -7, -6, -5,
	-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
	27, 28, 29, 30, 31, 32, 33, 34, 35, 38, 40, 43, 46, 49, 53, 58, 65, 73, 82, 92, 103, 115, 127,
];
const PITCH_MOD_SENS = [0, 10, 20, 33, 55, 92, 153, 255];
/** amplitude modulation sensitivity 0-3 as a fraction of the full depth */
const AMS_FRACTION = [0, 0.2588, 0.4274, 1];

const LG_N = 6;
const N = 1 << LG_N;
/** the DX7 sample rate: envelope blocks of 64 samples at 49096 Hz */
export const DX7_NATIVE_RATE = 49096;
const Q24 = 1 << 24;

const scaleOutLevel = (l: number): number => (l >= 20 ? 28 + l : LEVEL_LUT[l]);

function scaleVelocity(velocity: number, sensitivity: number): number {
	const v = Math.max(0, Math.min(127, velocity));
	return ((sensitivity * (VELOCITY_DATA[v >> 1] - 239) + 7) >> 3) << 4;
}

function scaleRate(midinote: number, sensitivity: number): number {
	const x = Math.min(31, Math.max(0, Math.floor(midinote / 3) - 7));
	return (sensitivity * x) >> 3;
}

function scaleCurve(group: number, depth: number, curve: number): number {
	const scale =
		curve === 0 || curve === 3
			? (group * depth * 329) >> 12
			: (EXP_SCALE_DATA[Math.min(group, EXP_SCALE_DATA.length - 1)] * depth * 329) >> 15;
	return curve < 2 ? -scale : scale;
}

function scaleLevel(midinote: number, bp: number, ld: number, rd: number, lc: number, rc: number): number {
	const offset = midinote - bp - 17;
	return offset >= 0 ? scaleCurve(Math.floor(offset / 3), rd, rc) : scaleCurve(Math.floor(-offset / 3), ld, lc);
}

/** four stage operator envelope; levels are in Q24 octaves, as the DX7 laws define them */
class Env {
	private level = 0;
	private targetLevel = 0;
	private inc = 0;
	private ix = 0;
	private rising = false;
	private down = true;

	constructor(
		private readonly rates: number[],
		private readonly levels: number[],
		private readonly outLevel: number,
		private readonly rateScaling: number,
	) {
		this.advance(0);
	}

	private advance(newIx: number): void {
		this.ix = newIx;
		if (this.ix < 4) {
			const actual = scaleOutLevel(this.levels[this.ix]) >> 1;
			let a = (actual << 6) + this.outLevel - 4256;
			a = a < 16 ? 16 : a;
			this.targetLevel = a * 65536;
			this.rising = this.targetLevel > this.level;
			let qrate = (this.rates[this.ix] * 41) >> 6;
			qrate += this.rateScaling;
			qrate = Math.min(qrate, 63);
			this.inc = (4 + (qrate & 3)) * 2 ** (2 + LG_N + (qrate >> 2));
		}
	}

	keyUp(): void {
		if (this.down) {
			this.down = false;
			this.advance(3);
		}
	}

	/** advance one block of 64 samples and return the level in Q24 octaves */
	block(): number {
		if (this.ix < 3 || (this.ix < 4 && !this.down)) {
			if (this.rising) {
				const jump = 1716 * 65536;
				if (this.level < jump) this.level = jump;
				this.level += Math.floor((17 * Q24 - this.level) / Q24) * this.inc;
				if (this.level >= this.targetLevel) {
					this.level = this.targetLevel;
					this.advance(this.ix + 1);
				}
			} else {
				this.level -= this.inc;
				if (this.level <= this.targetLevel) {
					this.level = this.targetLevel;
					this.advance(this.ix + 1);
				}
			}
		}
		return this.level;
	}
}

/** pitch envelope: returns an offset in octaves */
class PitchEnv {
	private level: number;
	private target = 0;
	private inc = 0;
	private ix = 0;
	private rising = false;
	private down = true;
	private readonly unit = Math.floor((N * Q24) / (21.3 * DX7_NATIVE_RATE) + 0.5);

	constructor(
		private readonly rates: number[],
		private readonly levels: number[],
	) {
		this.level = PITCH_TAB[levels[3]] * 2 ** 19;
		this.advance(0);
	}

	private advance(newIx: number): void {
		this.ix = newIx;
		if (this.ix < 4) {
			this.target = PITCH_TAB[this.levels[this.ix]] * 2 ** 19;
			this.rising = this.target > this.level;
			this.inc = PITCH_RATE_TAB[this.rates[this.ix]] * this.unit;
		}
	}

	keyUp(): void {
		if (this.down) {
			this.down = false;
			this.advance(3);
		}
	}

	block(): number {
		if (this.ix < 3 || (this.ix < 4 && !this.down)) {
			if (this.rising) {
				this.level += this.inc;
				if (this.level >= this.target) {
					this.level = this.target;
					this.advance(this.ix + 1);
				}
			} else {
				this.level -= this.inc;
				if (this.level <= this.target) {
					this.level = this.target;
					this.advance(this.ix + 1);
				}
			}
		}
		return this.level / Q24;
	}
}

/** log2 of the frequency in Hz of an operator */
function oscLog2(midinote: number, mode: number, coarse: number, fine: number, detune: number): number {
	if (mode === 0) {
		let l = Math.log2(440) + (midinote - 69) / 12;
		l += COARSE_MUL[coarse & 31] / Q24;
		if (fine) l += Math.log2(1 + 0.01 * fine);
		l += (12606 * (detune - 7)) / Q24;
		return l;
	}
	let l = Math.log2(10) * (((coarse & 3) * 100 + fine) / 100); // fixed frequency: 10^coarse * 10^(fine/100) Hz
	if (detune > 7) l += (13457 * (detune - 7)) / Q24;
	return l;
}

/** exponential of the chip's table in the log2/256 domain: amplitude 4084 at level 0, defined for negative levels too */
const EXP_TABLE = Array.from({ length: 256 }, (_, i) => 4084 * 2 ** (-i / 256));
const exp2q = (level: number): number => (level >= 256 * 14 ? 0 : EXP_TABLE[level & 255] * 2 ** -(level >> 8));

class Lfo {
	phase = 0;
	delayState = 0;
	private held = 0;
	private seed = 1;

	reset(sync: boolean): void {
		if (sync) this.phase = 0;
		this.delayState = 0;
	}

	/** frequency in Hz for a speed 0..99 (the fitted rate law of the reference engine) */
	static hz(speed: number): number {
		let sr = speed === 0 ? 1 : (165 * speed) >> 6;
		sr *= sr < 160 ? 11 : 11 + ((sr - 160) >> 4);
		return (25190424 / 2 ** 32) * sr;
	}

	/** onset gain 0..1 after the delay, ramping in */
	static delayInc(delay: number): number {
		const a = 99 - delay;
		return ((16 + (a & 15)) << (1 + (a >> 4))) * 25190424;
	}

	advance(dt: number, speed: number, delay: number): void {
		const before = this.phase;
		this.phase = (this.phase + Lfo.hz(speed) * dt) % 1;
		if (this.phase < before) {
			this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
			this.held = (this.seed >>> 8) / 2 ** 24;
		}
		this.delayState = Math.min(2 ** 32, this.delayState + Lfo.delayInc(delay) * dt);
	}

	/** wave value in -1..1 */
	value(wave: number): number {
		const p = this.phase;
		switch (wave) {
			case 0:
				return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
			case 1:
				return 1 - 2 * p;
			case 2:
				return 2 * p - 1;
			case 3:
				return p < 0.5 ? 1 : -1;
			case 4:
				return Math.sin(2 * Math.PI * p);
			default:
				return this.held * 2 - 1;
		}
	}

	fade(): number {
		const s = this.delayState;
		return s < 2 ** 31 ? 0 : (s - 2 ** 31) / 2 ** 31;
	}
}

class Note {
	readonly env: Env[] = [];
	readonly pitchEnv: PitchEnv;
	readonly basePitch: number[] = [];
	readonly phase = new Float64Array(6);
	readonly gain0 = new Float64Array(6);
	readonly gain1 = new Float64Array(6);
	readonly freq0 = new Float64Array(6);
	readonly freq1 = new Float64Array(6);
	readonly fb = [0, 0];
	readonly lfo = new Lfo();
	readonly algorithm: number;
	readonly fbShift: number;
	released = false;
	held = false;
	age = 0;

	constructor(
		readonly voice: Dx7Voice,
		readonly midinote: number,
		velocity: number,
	) {
		for (const op of voice.operators) {
			let outlevel = scaleOutLevel(op.outputLevel);
			outlevel += scaleLevel(midinote, op.breakPoint, op.leftDepth, op.rightDepth, op.leftCurve, op.rightCurve);
			outlevel = Math.min(127, outlevel);
			outlevel = Math.max(0, (outlevel << 5) + scaleVelocity(velocity, op.keyVelocitySens));
			this.env.push(new Env([...op.rates], [...op.levels], outlevel, scaleRate(midinote, op.rateScale)));
			this.basePitch.push(oscLog2(midinote, op.oscMode, op.freqCoarse, op.freqFine, op.detune));
		}
		this.pitchEnv = new PitchEnv([...voice.pitchEgRates], [...voice.pitchEgLevels]);
		this.algorithm = voice.algorithm;
		this.fbShift = voice.feedback !== 0 ? 8 - voice.feedback : 16;
	}

	keyUp(): void {
		this.released = true;
		for (const e of this.env) e.keyUp();
		this.pitchEnv.keyUp();
	}
}

export interface Dx7Controller {
	/** range 0-99 and assignment bits: 1 pitch, 2 amplitude, 4 EG bias */
	range: number;
	assign: number;
}

export interface Dx7Options extends ChipOptions {
	/** polyphony (default 16, as the DX7) */
	voices?: number;
	/** output gain (default 0.2) */
	level?: number;
	/** 'clean': double precision sines (default); 'authentic': 12 bit log-sine and exponential tables */
	accuracy?: 'clean' | 'authentic';
	/** run at the native 49096 Hz and resample (default true); false generates directly at the output rate */
	nativeRate?: boolean;
	/** pitch bend range in semitones (default 2) */
	bendRange?: number;
	/** transposition in semitones (default 0) */
	transpose?: number;
}

/** The engine as a chip: mono, on both sides. See the file header. */
export class Dx7Synth implements Chip {
	readonly id = 'dx7';
	readonly name = 'Yamaha DX7 (6 operator FM)';
	readonly channels = 6;
	readonly clock = 0;
	readonly sampleRate: number;
	readonly accuracy: 'clean' | 'authentic';
	readonly rate: number;
	/** controller response: modulation wheel, aftertouch, breath (defaults: wheel on pitch at 50) */
	readonly wheel: Dx7Controller = { range: 50, assign: 1 };
	readonly aftertouch: Dx7Controller = { range: 0, assign: 0 };
	readonly breath: Dx7Controller = { range: 0, assign: 0 };
	bendRange: number;
	transpose: number;
	private pitchBend = 0;
	private wheelValue = 0;
	private aftertouchValue = 0;
	private breathValue = 0;
	private sustain = false;
	private voice: Dx7Voice | null = null;
	private bank: Dx7Voice[] = [];
	private notes: Note[] = [];
	private readonly maxVoices: number;
	private age = 0;
	private readonly scale: number;
	private readonly enabled = [true, true, true, true, true, true];
	private blockCount = 0;
	private readonly resampler: SincResampler | null;

	constructor(options: Dx7Options = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.maxVoices = options.voices ?? 16;
		this.scale = options.level ?? 0.2;
		this.accuracy = options.accuracy ?? 'clean';
		this.bendRange = options.bendRange ?? 2;
		this.transpose = options.transpose ?? 0;
		const native = options.nativeRate ?? true;
		this.rate = native ? DX7_NATIVE_RATE : this.sampleRate;
		this.resampler = native
			? new SincResampler(DX7_NATIVE_RATE, this.sampleRate, (l, r, n) => this.generate(l, r, n))
			: null;
	}

	loadVoice(voice: Dx7Voice): void {
		this.voice = voice;
	}

	loadBank(voices: readonly Dx7Voice[]): void {
		this.bank = [...voices];
		this.voice = this.bank[0] ?? null;
	}

	selectVoice(index: number): void {
		const v = this.bank[index];
		if (v) this.voice = v;
	}

	/** switch one operator (1-6, as on the panel) on or off */
	setOperatorEnabled(operator: number, on: boolean): void {
		if (operator >= 1 && operator <= 6) this.enabled[6 - operator] = on;
	}

	noteOn(midinote: number, velocity = 100): void {
		if (!this.voice) return;
		if (velocity <= 0) return this.noteOff(midinote);
		const note = midinote + this.transpose;
		for (const n of this.notes) if (n.midinote === note && !n.released) n.keyUp();
		if (this.notes.length >= this.maxVoices) {
			const oldest = this.notes.reduce((a, b) => (a.age < b.age ? a : b));
			this.notes.splice(this.notes.indexOf(oldest), 1);
		}
		const n = new Note(this.voice, note, velocity);
		n.age = ++this.age;
		n.lfo.reset(this.voice.lfo.sync);
		this.notes.push(n);
	}

	noteOff(midinote: number): void {
		const note = midinote + this.transpose;
		for (const n of this.notes) {
			if (n.midinote !== note || n.released) continue;
			if (this.sustain) n.held = true;
			else n.keyUp();
		}
	}

	allNotesOff(): void {
		for (const n of this.notes) n.keyUp();
	}

	/** pitch bend in -1..1 */
	setPitchBend(v: number): void {
		this.pitchBend = Math.max(-1, Math.min(1, v));
	}
	setModWheel(v: number): void {
		this.wheelValue = Math.max(0, Math.min(1, v));
	}
	setAftertouch(v: number): void {
		this.aftertouchValue = Math.max(0, Math.min(1, v));
	}
	setBreath(v: number): void {
		this.breathValue = Math.max(0, Math.min(1, v));
	}
	setSustain(down: boolean): void {
		this.sustain = down;
		if (!down) for (const n of this.notes) if (n.held && !n.released) n.keyUp();
	}

	reset(): void {
		this.notes = [];
		this.blockCount = 0;
		this.pitchBend = this.wheelValue = this.aftertouchValue = this.breathValue = 0;
		this.sustain = false;
		this.resampler?.reset();
	}

	write(addr: number, value: number): void {
		if (addr < 128) this.noteOn(addr, value);
		else if (addr === 128) this.selectVoice(value);
		else if (addr === 129) this.setPitchBend((value - 8192) / 8192);
		else if (addr === 130) this.setModWheel(value / 127);
		else if (addr === 131) this.setAftertouch(value / 127);
		else if (addr === 132) this.setBreath(value / 127);
		else if (addr === 133) this.setSustain(value >= 64);
	}

	read(): number {
		return 0;
	}

	setMuted(channel: number, muted: boolean): void {
		this.setOperatorEnabled(channel + 1, !muted);
	}

	/** controller contribution (0..1) to one destination, summed over wheel / aftertouch / breath */
	private controller(bit: number): number {
		let v = 0;
		const add = (c: Dx7Controller, value: number): void => {
			if (c.assign & bit) v += (c.range / 99) * value;
		};
		add(this.wheel, this.wheelValue);
		add(this.aftertouch, this.aftertouchValue);
		add(this.breath, this.breathValue);
		return Math.min(1, v);
	}

	/** once per block of 64 native samples: envelopes, LFO, pitch and operator gains */
	private updateBlock(): void {
		const dt = N / DX7_NATIVE_RATE;
		const pitchCtl = this.controller(1);
		const ampCtl = this.controller(2);
		const biasCtl = this.controller(4);
		for (const n of this.notes) {
			const l = n.voice.lfo;
			n.lfo.advance(dt, l.speed, l.delay);
			const wave = n.lfo.value(l.wave);
			const fade = n.lfo.fade();
			const unipolar = (1 - wave) / 2; // amplitude modulation only attenuates
			const depthPitch = Math.max((((l.pitchModDepth * 165) >> 6) / 255) * fade, pitchCtl);
			const sens = PITCH_MOD_SENS[l.pitchModSens & 7];
			const lfoOctaves = depthPitch * sens * wave * (256 / Q24) * 255;
			const bend = (this.pitchBend * this.bendRange) / 12;
			const pitchMod = n.pitchEnv.block() + lfoOctaves + bend;
			const depthAmp = Math.max((l.ampModDepth / 99) * fade, ampCtl);
			for (let op = 0; op < 6; op++) {
				n.gain0[op] = n.gain1[op];
				n.freq0[op] = n.freq1[op];
				const params = n.voice.operators[op];
				let level = n.env[op].block() / Q24; // octaves
				const ams = AMS_FRACTION[params.ampModSens & 3];
				level -= depthAmp * ams * unipolar * 7;
				level += biasCtl * ams * 4;
				n.gain1[op] = this.enabled[op] ? 2 ** (level - 14) : 0;
				n.freq1[op] = 2 ** (n.basePitch[op] + pitchMod) / this.rate;
			}
		}
	}

	/** native / direct generation: ADD `n` mono frames (the resampler overwrites its own buffers) */
	private generate(left: Float32Array, right: Float32Array, n: number): void {
		for (let i = 0; i < n; i++) {
			if (this.blockCount % N === 0) {
				this.updateBlock();
				this.notes = this.notes.filter((note) => !this.finished(note));
			}
			const t = (this.blockCount % N) / N;
			this.blockCount++;
			let sum = 0;
			for (const note of this.notes) sum += this.sample(note, t);
			const out = sum * this.scale;
			left[i] = out;
			right[i] = out;
		}
	}

	private finished(n: Note): boolean {
		if (!n.released) return false;
		const alg = ALGORITHMS[n.algorithm];
		for (let op = 0; op < 6; op++) if ((alg[op] & 3) === 0 && n.gain1[op] > 2 ** -17) return false;
		return true;
	}

	/** one output sample of a note: the six operators through the algorithm */
	private sample(n: Note, t: number): number {
		const alg = ALGORITHMS[n.algorithm];
		const buses = [0, 0, 0];
		const touched = [true, false, false];
		const authentic = this.accuracy === 'authentic';
		let out = 0;
		for (let op = 0; op < 6; op++) {
			const flags = alg[op];
			const add = (flags & 4) !== 0;
			const inBus = (flags >> 4) & 3;
			const outBus = flags & 3;
			const gain = n.gain0[op] + (n.gain1[op] - n.gain0[op]) * t;
			let mod = 0;
			if (flags & 0x40 && n.fbShift < 16) mod += ((n.fb[0] + n.fb[1]) * 0.5) / 2 ** (n.fbShift - 1);
			if (inBus && touched[inBus]) mod += buses[inBus];
			let y: number;
			if (authentic) y = this.logSine(n.phase[op] + mod, gain);
			else y = Math.sin(2 * Math.PI * (n.phase[op] + mod)) * gain;
			if (flags & 0x80) {
				n.fb[1] = n.fb[0];
				n.fb[0] = y;
			}
			const f = n.freq0[op] + (n.freq1[op] - n.freq0[op]) * t;
			n.phase[op] = (n.phase[op] + f) % 1;
			if (outBus === 0) out += y;
			else {
				buses[outBus] = add && touched[outBus] ? buses[outBus] + y : y;
				touched[outBus] = true;
			}
		}
		return out;
	}

	/** sine through the 12 bit log-sine ROM, the attenuation added in 1/256 octaves, integer exponential */
	private logSine(phaseCycles: number, gain: number): number {
		if (gain <= 0) return 0;
		const p = Math.floor((phaseCycles - Math.floor(phaseCycles)) * 1024) & 1023;
		const q = p & 0x100 ? ~p & 0xff : p & 0xff;
		const att = Math.round(-Math.log2(gain) * 256); // the gain in 1/256 octaves of attenuation (gain 1 = 0)
		const amp = Math.round(exp2q(LOGSIN[q] + att)) / 4084;
		return p & 0x200 ? -amp : amp;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		if (this.resampler) this.resampler.render(left, right, start, count);
		else {
			const l = new Float32Array(count);
			const r = new Float32Array(count);
			this.generate(l, r, count);
			for (let i = 0; i < count; i++) {
				left[start + i] += l[i];
				right[start + i] += r[i];
			}
		}
	}
}

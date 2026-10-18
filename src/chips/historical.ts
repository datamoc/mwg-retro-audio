import type { Chip, ChipOptions } from './Chip.ts';

/**
 * Historical digital synthesizers modelled at the level of their *architecture*: how many oscillators, what drives
 * them, how the sound is shaped. None of these machines had a public register specification, so these are not
 * register-exact emulations (unlike the chips of the other modules): they are playable models that reproduce the
 * structure and the typical behaviour of each design, documented in the specification section 10, with the points
 * that are guesses marked in `CONFORMANCE.md`.
 *
 * - `AdditiveSynth`: the Bell Labs Digital Synthesizer (Alles, 1977: 32 oscillators) and the Dartmouth Digital
 *   Synthesizer (Alonso, 1972: 16 oscillators) share one architecture: a bank of table lookup oscillators, each with
 *   its own amplitude and frequency break-point functions, driven by a computer. Presets `bellLabs` / `dartmouth`.
 * - `Vl1`: Casio VL-1 (VL-Tone, 1979): one voice, a small set of fixed harmonic recipes, ADSR given as digits 0-9,
 *   vibrato.
 * - `Synclavier`: New England Digital Synclavier (1977-): per voice up to 4 partials, each a stack of up to 24
 *   harmonics with its own envelope and an FM modulation (ratio, depth) between partials.
 * - `Gs1`: Yamaha GS-1 (1981): 16 voices, each built from FM modulator/carrier pairs (8 operators arranged as
 *   pairs, with cross-modulation between pairs), a preset instrument whose voices came from a magnetic card
 *   library. `GS1_PRESETS` carries the 16 factory voice names with archetypal parameters reconstructed from the
 *   architecture: they are not dumps of the original card data, which is not publicly documented.
 * - `LaSynth` (Roland D-50 structure): two partials per tone, each either a synthesised wave (sawtooth, square with
 *   pulse width and modulation) or a PCM sample from a ROM, shaped by a resonant low-pass filter with its own envelope
 *   and an amplitude envelope. The PCM attack ROM is not part of the package: provide it through `PcmSource`.
 * - `AiSynth` (Korg M1 structure): up to two PCM oscillators per voice from a sample ROM through a filter and amplifier
 *   envelopes. Without a ROM the oscillators use the built-in synthesised waves.
 */

/** where a PCM based synth gets its samples: the user's own ROM dump, decoded to floats at `rate` Hz with a loop */
export interface PcmSource {
	/** sample data in -1..1 */
	data: Float32Array;
	rate: number;
	/** root note of the sample (default 60) */
	rootNote?: number;
	loopStart?: number;
	loopEnd?: number;
}

export type BreakPoints = readonly (readonly [time: number, level: number])[];

/** piecewise linear envelope with a sustain point and a release segment */
export class BreakPointEnvelope {
	private t = 0;
	private releaseT = -1;
	private releaseFrom = 0;
	private value = 0;

	constructor(
		private readonly points: BreakPoints,
		/** index of the point where the envelope waits for the key off (default: the last one) */
		private readonly sustainIndex = points.length - 1,
		/** release time in seconds from the level reached (default 0.2) */
		private readonly release = 0.2,
	) {}

	keyOff(): void {
		if (this.releaseT < 0) {
			this.releaseT = this.t;
			this.releaseFrom = this.value;
		}
	}

	get done(): boolean {
		return this.releaseT >= 0 && this.value <= 1e-5;
	}

	/** advance by `dt` seconds and return the level */
	next(dt: number): number {
		this.t += dt;
		if (this.releaseT >= 0) {
			const r = (this.t - this.releaseT) / Math.max(1e-4, this.release);
			this.value = r >= 1 ? 0 : this.releaseFrom * (1 - r);
			return this.value;
		}
		const p = this.points;
		const hold = p[Math.min(this.sustainIndex, p.length - 1)];
		const t = Math.min(this.t, hold[0]);
		let v = p[0][1];
		for (let i = 1; i < p.length; i++) {
			if (t <= p[i][0]) {
				const [t0, v0] = p[i - 1];
				const [t1, v1] = p[i];
				v = t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
				break;
			}
			v = p[i][1];
		}
		this.value = v;
		return v;
	}
}

/** state variable low-pass with resonance (trapezoidal integration: stable at any cut-off) */
export class LowPass {
	private ic1 = 0;
	private ic2 = 0;
	/** `damping` 2 = no resonance, small values = strong resonance */
	process(x: number, cutoffHz: number, damping: number, rate: number): number {
		const g = Math.tan((Math.PI * Math.min(cutoffHz, rate * 0.45)) / rate);
		const a1 = 1 / (1 + g * (g + damping));
		const a2 = g * a1;
		const a3 = g * a2;
		const v3 = x - this.ic2;
		const v1 = a1 * this.ic1 + a2 * v3;
		const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
		this.ic1 = 2 * v1 - this.ic1;
		this.ic2 = 2 * v2 - this.ic2;
		return v2;
	}
}

const noteHz = (n: number): number => 440 * 2 ** ((n - 69) / 12);

export abstract class PolyBase implements Chip {
	abstract readonly id: string;
	abstract readonly name: string;
	readonly channels = 1;
	readonly clock = 0;
	readonly sampleRate: number;
	protected muted = false;
	protected readonly level: number;

	constructor(options: ChipOptions & { level?: number } = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.level = options.level ?? 0.25;
	}

	abstract noteOn(note: number, velocity?: number): void;
	abstract noteOff(note: number): void;
	abstract reset(): void;
	protected abstract sample(): number;

	write(addr: number, value: number): void {
		if (addr >= 0 && addr < 128) this.noteOn(addr, value);
	}
	read(): number {
		return 0;
	}
	setMuted(_channel: number, muted: boolean): void {
		this.muted = muted;
	}
	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		if (this.muted) return;
		for (let i = 0; i < count; i++) {
			const s = this.sample() * this.level;
			left[start + i] += s;
			right[start + i] += s;
		}
	}
}

// ------------------------------------------------------------------------------------------------ additive

export interface Partial {
	/** frequency ratio to the note (1 = fundamental) */
	ratio: number;
	/** amplitude break-point function (seconds, 0..1) */
	amp: BreakPoints;
	/** optional frequency deviation break-point function (seconds, ratio multiplier, 1 = none) */
	freq?: BreakPoints;
	/** wave table of the oscillator (default: one cycle of a sine) */
	table?: Float32Array;
}

export interface AdditivePatch {
	partials: Partial[];
	release?: number;
}

const SINE_TABLE = Float32Array.from({ length: 1024 }, (_, i) => Math.sin((2 * Math.PI * i) / 1024));

interface AddVoice {
	note: number;
	velocity: number;
	phases: Float64Array;
	amps: BreakPointEnvelope[];
	freqs: (BreakPointEnvelope | null)[];
	age: number;
	released: boolean;
}

/** Bank of table lookup oscillators with break-point functions, shared between the notes as the real machines did */
export class AdditiveSynth extends PolyBase {
	readonly id = 'additive';
	readonly name: string;
	readonly oscillators: number;
	private patch: AdditivePatch = {
		partials: [
			{
				ratio: 1,
				amp: [
					[0, 0],
					[0.02, 1],
					[1, 0.6],
				],
			},
		],
	};
	private voices: AddVoice[] = [];
	private age = 0;

	constructor(
		options: ChipOptions & { level?: number; oscillators?: number; preset?: 'bellLabs' | 'dartmouth' } = {},
	) {
		super(options);
		const preset = options.preset ?? 'bellLabs';
		this.oscillators = options.oscillators ?? (preset === 'bellLabs' ? 32 : 16);
		this.name =
			preset === 'bellLabs' ? 'Bell Labs Digital Synthesizer (model)' : 'Dartmouth Digital Synthesizer (model)';
	}

	loadPatch(patch: AdditivePatch): void {
		this.patch = patch;
	}

	/** oscillators in use */
	get used(): number {
		return this.voices.length * this.patch.partials.length;
	}

	reset(): void {
		this.voices = [];
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		const per = this.patch.partials.length;
		// the bank is fixed: a new note takes the oscillators of the oldest note when there are not enough free ones
		while ((this.voices.length + 1) * per > this.oscillators && this.voices.length) {
			this.voices.sort((a, b) => a.age - b.age);
			this.voices.shift();
		}
		const release = this.patch.release ?? 0.25;
		this.voices.push({
			note,
			velocity: velocity / 127,
			phases: new Float64Array(per),
			amps: this.patch.partials.map((p) => new BreakPointEnvelope(p.amp, p.amp.length - 1, release)),
			freqs: this.patch.partials.map((p) =>
				p.freq ? new BreakPointEnvelope(p.freq, p.freq.length - 1, release) : null,
			),
			age: ++this.age,
			released: false,
		});
	}

	noteOff(note: number): void {
		for (const v of this.voices) {
			if (v.note === note && !v.released) {
				v.released = true;
				for (const e of v.amps) e.keyOff();
			}
		}
	}

	protected sample(): number {
		const dt = 1 / this.sampleRate;
		let sum = 0;
		for (const v of this.voices) {
			const f0 = noteHz(v.note);
			this.patch.partials.forEach((p, i) => {
				const amp = v.amps[i].next(dt) * v.velocity;
				const dev = v.freqs[i] ? v.freqs[i]!.next(dt) : 1;
				v.phases[i] = (v.phases[i] + f0 * p.ratio * dev * dt) % 1;
				const table = p.table ?? SINE_TABLE;
				const idx = v.phases[i] * table.length;
				const i0 = Math.floor(idx);
				const frac = idx - i0;
				sum += (table[i0] + (table[(i0 + 1) % table.length] - table[i0]) * frac) * amp;
			});
		}
		if (this.voices.some((v) => v.amps[0].done))
			this.voices = this.voices.filter((v) => !v.amps.every((e) => e.done));
		return sum;
	}
}

// ------------------------------------------------------------------------------------------------ VL-1

export type Vl1Sound = 'piano' | 'fantasy' | 'violin' | 'flute' | 'guitar' | 'electric piano' | 'adsr';
const VL1_HARMONICS: Record<Exclude<Vl1Sound, 'adsr'>, number[]> = {
	piano: [1, 0.5, 0.33, 0.25, 0.12, 0.06],
	fantasy: [1, 0, 0.6, 0, 0.4, 0.2],
	violin: [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
	flute: [1, 0.1, 0.05],
	guitar: [1, 0.7, 0.4, 0.3, 0.15],
	'electric piano': [1, 0.15, 0.4, 0.05, 0.1],
};

export interface Vl1Adsr {
	/** each parameter is a digit 0-9, as on the keypad */
	attack: number;
	decay: number;
	sustain: number;
	release: number;
}

/** Casio VL-1: one voice, a sound chosen among fixed harmonic recipes (or the user's ADSR), vibrato */
export class Vl1 extends PolyBase {
	readonly id = 'vl1';
	readonly name = 'Casio VL-1 (VL-Tone, model)';
	sound: Vl1Sound = 'piano';
	adsr: Vl1Adsr = { attack: 0, decay: 5, sustain: 5, release: 5 };
	vibrato = 0;
	private note = -1;
	private phase = 0;
	private env: BreakPointEnvelope | null = null;
	private t = 0;

	reset(): void {
		this.note = -1;
		this.env = null;
		this.phase = 0;
		this.t = 0;
	}

	/** seconds for a keypad digit: 0 = instantaneous, 9 = about 2 seconds */
	private static time(d: number): number {
		return d <= 0 ? 0.002 : 0.02 * 1.6 ** d;
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		this.note = note; // one voice: the last key wins
		this.t = 0;
		const a = this.sound === 'adsr' ? this.adsr : { attack: 0, decay: 6, sustain: 0, release: 3 };
		const sus = a.sustain / 9;
		const tA = Vl1.time(a.attack);
		const tD = tA + Vl1.time(a.decay);
		this.env = new BreakPointEnvelope(
			[
				[0, 0],
				[tA, 1],
				[tD, sus],
			],
			2,
			Vl1.time(a.release),
		);
	}

	noteOff(note: number): void {
		if (note === this.note) this.env?.keyOff();
	}

	protected sample(): number {
		if (!this.env || this.note < 0) return 0;
		const dt = 1 / this.sampleRate;
		this.t += dt;
		const e = this.env.next(dt);
		if (this.env.done) {
			this.env = null;
			return 0;
		}
		const vib = this.vibrato ? 1 + 0.006 * (this.vibrato / 9) * Math.sin(2 * Math.PI * 5.5 * this.t) : 1;
		this.phase = (this.phase + noteHz(this.note) * vib * dt) % 1;
		const harmonics = this.sound === 'adsr' ? VL1_HARMONICS.violin : VL1_HARMONICS[this.sound];
		let s = 0;
		harmonics.forEach((h, i) => (s += h * Math.sin(2 * Math.PI * this.phase * (i + 1))));
		return (s / 2) * e;
	}
}

// ------------------------------------------------------------------------------------------------ Synclavier

export interface SynclavierPartial {
	/** harmonic amplitudes, index 0 = fundamental (up to 24 harmonics) */
	harmonics: number[];
	/** FM: the previous partial modulates this one by this index (0 = off) */
	fmIndex?: number;
	/** FM modulator frequency ratio to the note */
	fmRatio?: number;
	amp: BreakPoints;
}
export interface SynclavierPatch {
	partials: SynclavierPartial[];
	release?: number;
}

interface SyVoice {
	note: number;
	velocity: number;
	phases: Float64Array;
	modPhase: Float64Array;
	envs: BreakPointEnvelope[];
	age: number;
	released: boolean;
}

/** Synclavier style voices: partials of stacked harmonics with an FM modulation between them */
export class Synclavier extends PolyBase {
	readonly id = 'synclavier';
	readonly name = 'New England Digital Synclavier (model)';
	private patch: SynclavierPatch = {
		partials: [
			{
				harmonics: [1, 0.5, 0.25],
				amp: [
					[0, 0],
					[0.01, 1],
					[1, 0.7],
				],
			},
		],
	};
	private voices: SyVoice[] = [];
	private age = 0;
	private readonly maxVoices = 8;

	loadPatch(p: SynclavierPatch): void {
		this.patch = p;
	}

	reset(): void {
		this.voices = [];
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		if (this.voices.length >= this.maxVoices) this.voices.shift();
		const n = this.patch.partials.length;
		this.voices.push({
			note,
			velocity: velocity / 127,
			phases: new Float64Array(n),
			modPhase: new Float64Array(n),
			envs: this.patch.partials.map(
				(p) => new BreakPointEnvelope(p.amp, p.amp.length - 1, this.patch.release ?? 0.3),
			),
			age: ++this.age,
			released: false,
		});
	}

	noteOff(note: number): void {
		for (const v of this.voices) {
			if (v.note === note && !v.released) {
				v.released = true;
				for (const e of v.envs) e.keyOff();
			}
		}
	}

	protected sample(): number {
		const dt = 1 / this.sampleRate;
		let sum = 0;
		for (const v of this.voices) {
			const f0 = noteHz(v.note);
			this.patch.partials.forEach((p, i) => {
				const amp = v.envs[i].next(dt) * v.velocity;
				v.modPhase[i] = (v.modPhase[i] + f0 * (p.fmRatio ?? 1) * dt) % 1;
				const mod = p.fmIndex ? p.fmIndex * Math.sin(2 * Math.PI * v.modPhase[i]) : 0;
				v.phases[i] = (v.phases[i] + f0 * dt) % 1;
				let s = 0;
				p.harmonics
					.slice(0, 24)
					.forEach((h, k) => (s += h * Math.sin(2 * Math.PI * (v.phases[i] * (k + 1)) + mod * (k + 1))));
				sum += s * amp;
			});
		}
		this.voices = this.voices.filter((v) => !v.envs.every((e) => e.done));
		return sum * 0.5;
	}
}

// ------------------------------------------------------------------------------------------------ GS-1

export interface Gs1Pair {
	/** carrier frequency ratio to the note (1 = fundamental) */
	carrierRatio: number;
	/** modulator frequency ratio to the note */
	modRatio: number;
	/** peak FM index in radians, scaled by the modulator envelope */
	modIndex: number;
	/** carrier amplitude break-point function */
	carrier: BreakPoints;
	/** modulator amplitude break-point function (its level drives the index) */
	modulator: BreakPoints;
	/** index of another pair whose carrier output also phase-modulates this pair (cross-modulation) */
	cross?: number;
	/** cross-modulation depth in radians (default 1) */
	crossIndex?: number;
	/** pair detune in cents */
	detuneCents?: number;
	/** pair output level (default 1) */
	level?: number;
	/** 0..1: how much of the modulator index follows the key velocity (default: none) */
	velSens?: number;
}

export interface Gs1Lfo {
	/** rate in Hz */
	rate: number;
	/** vibrato: fractional pitch depth (0.01 = +-1 %); tremolo: depth 0..1 of the amplitude dip */
	depth: number;
}

export interface Gs1Patch {
	/** up to 4 modulator/carrier pairs (8 operators) */
	pairs: Gs1Pair[];
	release?: number;
	vibrato?: Gs1Lfo;
	tremolo?: Gs1Lfo;
}

const gsEnv = {
	/** fast attack, decaying to silence while held (plucked / struck sounds) */
	pluck: (seconds: number, tail = 0): BreakPoints => [
		[0, 0],
		[0.004, 1],
		[seconds, tail],
	],
	sustain: (level = 1, attack = 0.01): BreakPoints => [
		[0, 0],
		[attack, 1],
		[1, level],
	],
	slow: (level = 0.8): BreakPoints => [
		[0, 0],
		[0.25, 1],
		[1, level],
	],
};

interface Gs1PairExtra {
	cross?: number;
	crossIndex?: number;
	detuneCents?: number;
	level?: number;
	velSens?: number;
}

const gsPair = (
	carrierRatio: number,
	modRatio: number,
	modIndex: number,
	carrier: BreakPoints,
	modulator: BreakPoints,
	extra: Gs1PairExtra = {},
): Gs1Pair => ({ carrierRatio, modRatio, modIndex, carrier, modulator, ...extra });

/**
 * The 16 factory voice names of the GS-1 card library, with archetypal parameters rebuilt from the architecture
 * (pair ratios, indices, envelope shapes). The original card data is not published: these are playable
 * reconstructions in the character of each name, not the factory sounds.
 */
export const GS1_PRESETS: readonly { name: string; patch: Gs1Patch }[] = [
	{
		name: 'Harpsichord I',
		patch: {
			release: 0.08,
			pairs: [
				gsPair(1, 2, 2.5, gsEnv.pluck(0.5), gsEnv.pluck(0.15), { velSens: 0.6 }),
				gsPair(2, 3, 1.5, gsEnv.pluck(0.3), gsEnv.pluck(0.1), { level: 0.5 }),
			],
		},
	},
	{
		name: 'Harpsichord III',
		patch: {
			release: 0.08,
			pairs: [
				gsPair(1, 3, 3.5, gsEnv.pluck(0.45), gsEnv.pluck(0.12), { velSens: 0.6 }),
				gsPair(2, 5, 2, gsEnv.pluck(0.25), gsEnv.pluck(0.08), { level: 0.45, cross: 0 }),
			],
		},
	},
	{
		name: 'Clavichord I',
		patch: {
			release: 0.06,
			pairs: [gsPair(1, 1, 1.4, gsEnv.pluck(0.6), gsEnv.pluck(0.25), { velSens: 0.8 })],
		},
	},
	{
		name: 'Clavichord II',
		patch: {
			release: 0.06,
			pairs: [
				gsPair(1, 2, 1.8, gsEnv.pluck(0.55), gsEnv.pluck(0.2), { velSens: 0.8 }),
				gsPair(3, 4, 1, gsEnv.pluck(0.3), gsEnv.pluck(0.12), { level: 0.35 }),
			],
		},
	},
	{
		name: 'Vibraphone',
		patch: {
			release: 0.4,
			tremolo: { rate: 4.5, depth: 0.3 },
			pairs: [
				gsPair(1, 1, 1.2, gsEnv.pluck(2.5), gsEnv.pluck(0.4), { velSens: 0.5 }),
				gsPair(4, 4, 0.8, gsEnv.pluck(0.8), gsEnv.pluck(0.2), { level: 0.3 }),
			],
		},
	},
	{
		name: 'Celeste',
		patch: {
			release: 0.3,
			pairs: [
				gsPair(1, 4, 1, gsEnv.pluck(2), gsEnv.pluck(0.5)),
				gsPair(2, 8, 0.8, gsEnv.pluck(1.2), gsEnv.pluck(0.3), { level: 0.35, detuneCents: 7 }),
			],
		},
	},
	{
		name: 'String I',
		patch: {
			release: 0.3,
			pairs: [
				gsPair(1, 1, 0.9, gsEnv.slow(), gsEnv.slow(0.7)),
				gsPair(2, 2, 0.6, gsEnv.slow(0.7), gsEnv.slow(0.6), { level: 0.5, detuneCents: 5 }),
			],
		},
	},
	{
		name: 'String Ensemble I',
		patch: {
			release: 0.35,
			pairs: [
				gsPair(1, 1, 1, gsEnv.slow(), gsEnv.slow(0.7), { detuneCents: -6 }),
				gsPair(1, 2, 0.7, gsEnv.slow(0.8), gsEnv.slow(0.6), { level: 0.7, detuneCents: 6 }),
				gsPair(2, 3, 0.5, gsEnv.slow(0.7), gsEnv.slow(0.5), { level: 0.4, detuneCents: 3 }),
			],
		},
	},
	{
		name: 'Acoustic Piano I',
		patch: {
			release: 0.15,
			pairs: [
				gsPair(1, 1, 2.2, gsEnv.pluck(1.8), gsEnv.pluck(0.5), { velSens: 0.7 }),
				gsPair(1, 2, 1.4, gsEnv.pluck(1), gsEnv.pluck(0.3), { level: 0.55, velSens: 0.7 }),
			],
		},
	},
	{
		name: 'Electric Piano I',
		patch: {
			release: 0.2,
			pairs: [
				gsPair(1, 1, 1.6, gsEnv.pluck(2.2), gsEnv.pluck(0.25), { velSens: 0.6 }),
				gsPair(1, 14, 0.7, gsEnv.pluck(0.15, 0.4), gsEnv.pluck(0.08), { level: 0.4 }),
			],
		},
	},
	{
		name: 'Brass I',
		patch: {
			release: 0.2,
			pairs: [
				gsPair(1, 1, 1.8, gsEnv.sustain(0.85, 0.08), gsEnv.sustain(0.8, 0.12), { velSens: 0.5 }),
				gsPair(2, 2, 0.8, gsEnv.sustain(0.6, 0.1), gsEnv.sustain(0.6, 0.15), { level: 0.45 }),
			],
		},
	},
	{
		name: 'Brass II',
		patch: {
			release: 0.2,
			pairs: [
				gsPair(1, 1, 2.6, gsEnv.sustain(0.9, 0.06), gsEnv.sustain(0.9, 0.09), { velSens: 0.6 }),
				gsPair(1, 3, 1.2, gsEnv.sustain(0.6, 0.08), gsEnv.sustain(0.7, 0.1), { level: 0.5, detuneCents: 4 }),
			],
		},
	},
	{
		name: 'Synth Brass III',
		patch: {
			release: 0.2,
			pairs: [
				gsPair(1, 1, 2, gsEnv.sustain(0.9, 0.05), gsEnv.sustain(0.85, 0.07), { detuneCents: -5 }),
				gsPair(1, 1, 2, gsEnv.sustain(0.9, 0.05), gsEnv.sustain(0.85, 0.07), { detuneCents: 5, level: 0.9 }),
			],
		},
	},
	{
		name: 'Electronic Organ I',
		patch: {
			release: 0.12,
			pairs: [
				gsPair(1, 1, 0.6, gsEnv.sustain(1, 0.005), gsEnv.sustain(1, 0.005)),
				gsPair(2, 2, 0.5, gsEnv.sustain(0.8, 0.005), gsEnv.sustain(0.8, 0.005), { level: 0.55 }),
				gsPair(3, 3, 0.4, gsEnv.sustain(0.7, 0.005), gsEnv.sustain(0.7, 0.005), { level: 0.35 }),
			],
		},
	},
	{
		name: 'Electronic Organ II',
		patch: {
			release: 0.12,
			pairs: [
				gsPair(1, 1, 0.9, gsEnv.sustain(1, 0.005), gsEnv.sustain(1, 0.005)),
				gsPair(2, 4, 0.7, gsEnv.sustain(0.8, 0.005), gsEnv.sustain(0.8, 0.005), { level: 0.5, cross: 0 }),
				gsPair(4, 4, 0.5, gsEnv.sustain(0.7, 0.005), gsEnv.sustain(0.7, 0.005), { level: 0.3 }),
			],
		},
	},
	{
		name: 'Pipe Organ',
		patch: {
			release: 0.5,
			pairs: [
				gsPair(1, 1, 0.5, gsEnv.sustain(1, 0.03), gsEnv.sustain(1, 0.03)),
				gsPair(2, 2, 0.45, gsEnv.sustain(0.85, 0.03), gsEnv.sustain(0.85, 0.03), { level: 0.6 }),
				gsPair(4, 4, 0.4, gsEnv.sustain(0.7, 0.03), gsEnv.sustain(0.7, 0.03), { level: 0.35, cross: 1 }),
			],
		},
	},
];

interface GsVoice {
	note: number;
	velocity: number;
	carrierPhase: Float64Array;
	modPhase: Float64Array;
	carrierEnvs: BreakPointEnvelope[];
	modEnvs: BreakPointEnvelope[];
	lastOut: Float64Array;
	t: number;
	age: number;
	released: boolean;
}

/** Yamaha GS-1 style voices: FM modulator/carrier pairs in parallel, cross-modulation, 16 voice polyphony */
export class Gs1 extends PolyBase {
	readonly id = 'gs1';
	readonly name = 'Yamaha GS-1 (model)';
	/** index in `GS1_PRESETS` of the loaded preset */
	preset = 0;
	vibrato: Gs1Lfo | null = null;
	tremolo: Gs1Lfo | null = null;
	private patch: Gs1Patch = GS1_PRESETS[0].patch;
	private voices: GsVoice[] = [];
	private age = 0;
	private readonly maxVoices = 16;

	loadPatch(patch: Gs1Patch): void {
		this.patch = patch;
		this.vibrato = patch.vibrato ?? null;
		this.tremolo = patch.tremolo ?? null;
	}

	selectPreset(index: number): void {
		const p = GS1_PRESETS[index];
		if (!p) return;
		this.preset = index;
		this.loadPatch(p.patch);
	}

	get activeVoices(): number {
		return this.voices.length;
	}

	override write(addr: number, value: number): void {
		if (addr === 128) this.selectPreset(value);
		else super.write(addr, value);
	}

	reset(): void {
		this.voices = [];
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		if (this.voices.length >= this.maxVoices) this.voices.shift();
		const pairs = this.patch.pairs.slice(0, 4);
		const release = this.patch.release ?? 0.2;
		this.voices.push({
			note,
			velocity: velocity / 127,
			carrierPhase: new Float64Array(pairs.length),
			modPhase: new Float64Array(pairs.length),
			carrierEnvs: pairs.map((p) => new BreakPointEnvelope(p.carrier, p.carrier.length - 1, release)),
			modEnvs: pairs.map((p) => new BreakPointEnvelope(p.modulator, p.modulator.length - 1, release)),
			lastOut: new Float64Array(pairs.length),
			t: 0,
			age: ++this.age,
			released: false,
		});
	}

	noteOff(note: number): void {
		for (const v of this.voices) {
			if (v.note === note && !v.released) {
				v.released = true;
				for (const e of v.carrierEnvs) e.keyOff();
				for (const e of v.modEnvs) e.keyOff();
			}
		}
	}

	protected sample(): number {
		const dt = 1 / this.sampleRate;
		const pairs = this.patch.pairs.slice(0, 4);
		let sum = 0;
		for (const v of this.voices) {
			v.t += dt;
			const f0 = noteHz(v.note);
			const vib = this.vibrato ? 1 + this.vibrato.depth * Math.sin(2 * Math.PI * this.vibrato.rate * v.t) : 1;
			const trem = this.tremolo
				? 1 - this.tremolo.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * this.tremolo.rate * v.t))
				: 1;
			const out = new Float64Array(pairs.length);
			pairs.forEach((p, i) => {
				const cEnv = v.carrierEnvs[i].next(dt);
				const mEnv = v.modEnvs[i].next(dt);
				const detune = 2 ** ((p.detuneCents ?? 0) / 1200);
				v.modPhase[i] = (v.modPhase[i] + f0 * p.modRatio * vib * detune * dt) % 1;
				v.carrierPhase[i] = (v.carrierPhase[i] + f0 * p.carrierRatio * vib * detune * dt) % 1;
				const velScale = p.velSens ? 1 - p.velSens + p.velSens * v.velocity : 1;
				const index = p.modIndex * mEnv * velScale;
				const cross =
					p.cross !== undefined && v.lastOut[p.cross] !== undefined
						? v.lastOut[p.cross] * (p.crossIndex ?? 1)
						: 0;
				out[i] =
					Math.sin(2 * Math.PI * v.carrierPhase[i] + index * Math.sin(2 * Math.PI * v.modPhase[i]) + cross) *
					cEnv;
				sum += out[i] * (p.level ?? 1) * v.velocity * trem;
			});
			v.lastOut = out;
		}
		this.voices = this.voices.filter((v) => !v.carrierEnvs.every((e) => e.done));
		return sum * 0.4;
	}
}

// ------------------------------------------------------------------------------------------------ LA and AI structures

export interface FilterVoiceParams {
	wave: 'saw' | 'square' | 'noise' | 'pcm';
	/** pulse width 0.05-0.95 for 'square' */
	pulseWidth?: number;
	/** pulse width modulation depth and rate (Hz) */
	pwmDepth?: number;
	pwmRate?: number;
	/** low-pass cut-off (Hz) at the start and the envelope depth in octaves; resonance 0-1 */
	cutoff: number;
	filterDepth?: number;
	resonance?: number;
	filterEnv?: BreakPoints;
	amp: BreakPoints;
	release?: number;
	pcm?: PcmSource;
}

interface FilterVoice {
	note: number;
	velocity: number;
	phase: number;
	lfoPhase: number;
	pcmPos: number;
	ampEnv: BreakPointEnvelope;
	filtEnv: BreakPointEnvelope;
	filter: LowPass;
	noise: number;
	released: boolean;
	age: number;
}

class FilterSynth extends PolyBase {
	readonly id: string;
	readonly name: string;
	protected partials: FilterVoiceParams[] = [
		{
			wave: 'saw',
			cutoff: 2000,
			amp: [
				[0, 0],
				[0.01, 1],
				[1, 0.7],
			],
		},
	];
	private voices: FilterVoice[][] = [];
	private age = 0;
	private rngState = 12345;

	constructor(id: string, name: string, options: ChipOptions & { level?: number } = {}) {
		super(options);
		this.id = id;
		this.name = name;
	}

	loadPatch(partials: FilterVoiceParams[]): void {
		this.partials = partials;
	}

	reset(): void {
		this.voices = [];
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		if (this.voices.length >= 8) this.voices.shift();
		this.voices.push(
			this.partials.map((p) => ({
				note,
				velocity: velocity / 127,
				phase: 0,
				lfoPhase: 0,
				pcmPos: 0,
				ampEnv: new BreakPointEnvelope(p.amp, p.amp.length - 1, p.release ?? 0.3),
				filtEnv: new BreakPointEnvelope(
					p.filterEnv ?? [
						[0, 1],
						[1, 1],
					],
					(
						p.filterEnv ?? [
							[0, 1],
							[1, 1],
						]
					).length - 1,
					p.release ?? 0.3,
				),
				filter: new LowPass(),
				noise: 0,
				released: false,
				age: ++this.age,
			})),
		);
	}

	noteOff(note: number): void {
		for (const group of this.voices) {
			for (const v of group) {
				if (v.note === note && !v.released) {
					v.released = true;
					v.ampEnv.keyOff();
					v.filtEnv.keyOff();
				}
			}
		}
	}

	private random(): number {
		this.rngState = (this.rngState * 1664525 + 1013904223) >>> 0;
		return (this.rngState >>> 8) / 2 ** 23 - 1;
	}

	protected sample(): number {
		const dt = 1 / this.sampleRate;
		let sum = 0;
		for (const group of this.voices) {
			group.forEach((v, i) => {
				const p = this.partials[i];
				const f = noteHz(v.note);
				let x: number;
				if (p.wave === 'pcm' && p.pcm) {
					const src = p.pcm;
					const ratio = (f / noteHz(src.rootNote ?? 60)) * (src.rate / this.sampleRate);
					v.pcmPos += ratio;
					const end = src.loopEnd ?? src.data.length;
					if (v.pcmPos >= end)
						v.pcmPos =
							src.loopStart !== undefined
								? src.loopStart + ((v.pcmPos - end) % Math.max(1, end - src.loopStart))
								: src.data.length;
					const i0 = Math.floor(v.pcmPos);
					x =
						i0 < src.data.length - 1
							? src.data[i0] + (src.data[i0 + 1] - src.data[i0]) * (v.pcmPos - i0)
							: 0;
				} else {
					v.phase = (v.phase + f * dt) % 1;
					v.lfoPhase = (v.lfoPhase + (p.pwmRate ?? 0) * dt) % 1;
					if (p.wave === 'saw') x = 2 * v.phase - 1;
					else if (p.wave === 'square') {
						const pw = Math.min(
							0.95,
							Math.max(
								0.05,
								(p.pulseWidth ?? 0.5) + (p.pwmDepth ?? 0) * Math.sin(2 * Math.PI * v.lfoPhase),
							),
						);
						x = v.phase < pw ? 1 : -1;
					} else x = this.random();
				}
				const cutoff = p.cutoff * 2 ** ((p.filterDepth ?? 0) * (v.filtEnv.next(dt) - 1));
				const filtered = v.filter.process(x, cutoff, 2 - 1.9 * (p.resonance ?? 0.1), this.sampleRate);
				sum += filtered * v.ampEnv.next(dt) * v.velocity;
			});
		}
		this.voices = this.voices.filter((g) => !g.every((v) => v.ampEnv.done));
		return sum * 0.5;
	}
}

/** Roland D-50 structure: partials = synthesised or PCM waves, resonant low-pass, envelopes (LA synthesis model) */
export class LaSynth extends FilterSynth {
	constructor(options: ChipOptions & { level?: number } = {}) {
		super('la-synth', 'Roland D-50 structure (LA synthesis model)', options);
	}
}

/** Korg M1 structure: PCM oscillators through filter and amplifier envelopes (AI synthesis model) */
export class AiSynth extends FilterSynth {
	constructor(options: ChipOptions & { level?: number } = {}) {
		super('ai-synth', 'Korg M1 structure (AI synthesis model)', options);
	}
}

// ------------------------------------------------------------------------------------------------ D-50, no ROM

/**
 * The PCM half of LA synthesis without any ROM. The attack waveforms of the original are recordings and are neither
 * reproduced nor distributed here: each entry is a small parametric recipe (up to 6 decaying partials [ratio to the
 * pitch, amplitude, decay in s] plus a noise burst) rendered by `renderAttackRecipe`. The numbers were fitted by
 * `tools/rom-analysis` on measurements of the user's own D-50 sample ROM, read offline: they describe how that
 * ROM's attacks are built (spectrum, decay, noise), they are not samples. Each entry keeps the name of the role it
 * was matched to by its spectral features (a sort of "Piano Hammer"), which is a label of convenience, not the name
 * of a Roland wave.
 */
export interface D50Attack {
	name: string;
	/** [frequency ratio to the root, amplitude, decay in seconds] */
	harmonics: readonly (readonly [number, number, number])[];
	/** noise burst amplitude and decay in seconds (0 = no noise) */
	noise: number;
	noiseDecay: number;
	/** total length in seconds */
	duration: number;
}

const atk = (
	name: string,
	harmonics: D50Attack['harmonics'],
	noise = 0,
	noiseDecay = 0.03,
	duration = 0.6,
): D50Attack => ({ name, harmonics, noise, noiseDecay, duration });

export const D50_ATTACKS: readonly D50Attack[] = [
	atk(
		'Piano Hammer',
		[
			[6, 1, 0.016],
			[9, 0.934, 0.014],
			[3, 0.586, 0.019],
			[15, 0.432, 0.016],
			[12, 0.384, 0.02],
			[18, 0.326, 0.016],
		],
		0.425,
		0.023,
		0.3,
	),
	atk(
		'E.Piano Tine',
		[
			[20, 1, 0.063],
			[0.812, 0.58, 0.038],
			[12.439, 0.42, 0.012],
			[14.114, 0.407, 0.012],
		],
		0.128,
		0.01,
		0.3,
	),
	atk(
		'Harpsichord Plectrum',
		[
			[2, 1, 0.017],
			[5, 0.76, 0.017],
			[1, 0.898, 0.01],
			[4, 0.533, 0.029],
			[6, 0.366, 0.016],
			[3, 0.202, 0.036],
		],
		0.746,
		0.011,
		0.3,
	),
	atk(
		'Clavinet Pick',
		[
			[2, 1, 0.016],
			[3, 0.755, 0.016],
			[4, 0.092, 0.017],
			[6, 0.063, 0.011],
			[5, 0.058, 0.012],
		],
		0.067,
		0.015,
		0.3,
	),
	atk(
		'Acoustic Guitar Pick',
		[
			[5.833, 1, 0.025],
			[9.135, 0.651, 0.032],
			[17, 0.809, 0.01],
			[0.88, 0.41, 0.046],
			[13.207, 0.559, 0.02],
			[16.619, 0.441, 0.01],
		],
		0.66,
		0.021,
		0.3,
	),
	atk(
		'Nylon Pluck',
		[
			[1, 1, 0.028],
			[2, 0.882, 0.027],
			[5, 0.092, 0.03],
			[4, 0.048, 0.024],
			[3, 0.054, 0.026],
		],
		0.102,
		0.04,
		0.3,
	),
	atk(
		'Bass Slap',
		[
			[2.068, 1, 0.024],
			[1, 0.764, 0.019],
			[3.102, 0.798, 0.023],
			[9, 0.432, 0.022],
			[7.238, 0.377, 0.013],
			[16, 0.272, 0.02],
		],
		0.812,
		0.018,
		0.3,
	),
	atk(
		'Violin Bow',
		[
			[2, 1, 0.059],
			[1, 0.531, 0.043],
			[4, 0.432, 0.08],
			[3, 0.456, 0.066],
			[5, 0.259, 0.051],
			[8, 0.045, 0.078],
		],
		0.083,
		0.065,
		0.3,
	),
	atk(
		'Cello Bow',
		[
			[1, 1, 0.092],
			[3, 0.516, 0.086],
			[2, 0.372, 0.084],
			[6, 0.343, 0.078],
			[5, 0.131, 0.061],
			[4, 0.091, 0.048],
		],
		0.219,
		0.086,
		0.3,
	),
	atk(
		'Flute Chiff',
		[
			[1, 1, 0.037],
			[2.144, 0.517, 0.025],
			[12, 0.488, 0.02],
			[4.783, 0.254, 0.02],
			[14.843, 0.267, 0.031],
			[3, 0.232, 0.044],
		],
		0.734,
		0.035,
		0.3,
	),
	atk(
		'Pan Flute Breath',
		[
			[5, 1, 0.023],
			[6, 1, 0.021],
			[7, 0.998, 0.02],
			[9, 0.461, 0.022],
			[14, 0.343, 0.027],
			[16, 0.326, 0.026],
		],
		0.705,
		0.104,
		0.3,
	),
	atk(
		'Trumpet Blast',
		[
			[1, 1, 0.061],
			[3, 0.826, 0.067],
			[4, 0.791, 0.041],
			[2, 0.525, 0.041],
			[5, 0.31, 0.057],
			[37, 0.234, 0.041],
		],
		0.503,
		0.055,
		0.3,
	),
	atk(
		'Trombone Buzz',
		[
			[2, 1, 0.047],
			[3, 1, 0.047],
			[6, 0.394, 0.053],
			[5, 0.394, 0.053],
			[18.892, 0.18, 0.044],
			[10.937, 0.15, 0.056],
		],
		0.323,
		0.057,
		0.3,
	),
	atk(
		'Sax Growl',
		[
			[2, 1, 0.04],
			[3, 0.431, 0.048],
			[4, 0.36, 0.052],
			[4.934, 0.339, 0.053],
			[13.075, 0.265, 0.046],
			[1, 0.216, 0.052],
		],
		0.481,
		0.041,
		0.3,
	),
	atk(
		'Clarinet Reed',
		[
			[3, 1, 0.061],
			[11.281, 0.186, 0.031],
			[17.167, 0.076, 0.033],
		],
		0.315,
		0.079,
		0.3,
	),
	atk(
		'Bell Strike',
		[
			[3, 1, 2.519],
			[4, 0.928, 0.085],
			[1, 0.881, 0.05],
			[2, 0.881, 3],
			[1.5, 0.881, 3],
			[5, 0.795, 0.028],
		],
		0.755,
		0.02,
		0.32,
	),
	atk(
		'Vibraphone Mallet',
		[
			[2, 1, 0.086],
			[6, 0.295, 0.074],
			[4, 0.24, 0.727],
			[10, 0.076, 0.01],
			[12, 0.05, 0.102],
			[34, 0.042, 0.025],
		],
		0.065,
		0.364,
		0.45,
	),
	atk(
		'Marimba Mallet',
		[
			[1, 1, 0.034],
			[3.939, 0.591, 0.028],
			[12.119, 0.304, 0.025],
			[13.209, 0.155, 0.025],
			[3.333, 0.073, 0.03],
			[15.936, 0.036, 0.024],
		],
		0.151,
		0.028,
		0.3,
	),
	atk(
		'Steel Drum',
		[
			[2, 1, 0.055],
			[6, 0.572, 0.04],
			[4, 0.275, 0.034],
			[0.687, 0.138, 0.022],
			[1.562, 0.097, 0.024],
			[10, 0.036, 0.023],
		],
		0.219,
		0.026,
		0.3,
	),
	atk(
		'Log Drum',
		[
			[2, 1, 0.013],
			[0.929, 0.811, 0.018],
			[2.476, 0.313, 0.012],
			[5, 0.265, 0.013],
			[3.281, 0.187, 0.011],
			[4.581, 0.183, 0.015],
		],
		0.25,
		0.036,
		0.3,
	),
	atk(
		'Choir Air',
		[
			[1, 1, 0.055],
			[3, 0.61, 0.08],
			[5, 0.49, 0.071],
			[2, 0.472, 0.065],
			[4, 0.475, 0.071],
			[8.911, 0.335, 0.073],
		],
		0.918,
		0.098,
		0.3,
	),
	atk(
		'Synth Sweep',
		[
			[2, 0.974, 0.026],
			[6, 1, 0.019],
			[3, 0.909, 0.026],
			[4, 0.759, 0.026],
			[1, 0.067, 0.107],
		],
		0.02,
		0.025,
		0.3,
	),
	atk(
		'Noise Snap',
		[
			[20.848, 0.702, 0.03],
			[22, 0.591, 0.021],
			[20.146, 0.45, 0.031],
			[29, 0.507, 0.027],
			[23, 0.604, 0.039],
			[30, 0.42, 0.028],
		],
		1,
		0.036,
		0.3,
	),
	atk(
		'Orchestra Hit',
		[
			[5, 1, 0.01],
			[6, 0.78, 0.01],
			[4, 0.706, 0.01],
			[7, 0.4, 0.01],
			[1, 0.374, 0.01],
			[3, 0.304, 0.01],
		],
		0.596,
		0.011,
		0.3,
	),
];

const attackCache = new Map<string, Float32Array>();

/** render one attack recipe at `rate` Hz with the partials rooted at `rootHz`; deterministic, no ROM data */
export function renderAttackRecipe(recipe: D50Attack, rate: number, rootHz: number, seedBase = 22222): Float32Array {
	const n = Math.max(1, Math.floor(recipe.duration * rate));
	const out = new Float32Array(n);
	let seed = seedBase;
	const white = (): number => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return (seed >>> 8) / 2 ** 23 - 1;
	};
	let peak = 0;
	for (let i = 0; i < n; i++) {
		const t = i / rate;
		let s = recipe.noise ? recipe.noise * white() * Math.exp(-t / Math.max(1e-4, recipe.noiseDecay)) : 0;
		for (const [ratio, amp, decay] of recipe.harmonics)
			s += amp * Math.sin(2 * Math.PI * rootHz * ratio * t) * Math.exp(-t / Math.max(1e-4, decay));
		out[i] = s;
		peak = Math.max(peak, Math.abs(s));
	}
	if (peak > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.9;
	return out;
}

/** generate (and cache) the synthesized attack `index` at `rate` Hz, rooted at note 60; deterministic, no ROM data */
export function synthAttackWave(index: number, rate: number): Float32Array {
	const recipe = D50_ATTACKS[((index % D50_ATTACKS.length) + D50_ATTACKS.length) % D50_ATTACKS.length];
	const key = `${recipe.name}@${rate}`;
	const cached = attackCache.get(key);
	if (cached) return cached;
	const out = renderAttackRecipe(recipe, rate, noteHz(60), 22222 + index * 1013);
	attackCache.set(key, out);
	return out;
}

const harmonicTables = new WeakMap<readonly number[], Map<number, Float32Array>>();

/** single-cycle table (2048 points + 1) summed from relative harmonic amplitudes, keeping the harmonics that fit under `maxHarmonic`; cached */
export function harmonicTable(harmonics: readonly number[], maxHarmonic: number): Float32Array {
	const h = Math.max(1, Math.min(harmonics.length, maxHarmonic | 0));
	let byCount = harmonicTables.get(harmonics);
	if (!byCount) harmonicTables.set(harmonics, (byCount = new Map()));
	const cached = byCount.get(h);
	if (cached) return cached;
	const n = 2048;
	const t = new Float32Array(n + 1);
	let peak = 0;
	for (let i = 0; i < n; i++) {
		let s = 0;
		for (let k = 1; k <= h; k++) s += harmonics[k - 1] * Math.sin((2 * Math.PI * k * i) / n);
		t[i] = s;
		peak = Math.max(peak, Math.abs(s));
	}
	for (let i = 0; i < n; i++) t[i] /= peak || 1;
	t[n] = t[0];
	byCount.set(h, t);
	return t;
}

export interface D50Partial {
	/** left out of the direct mix; its signal still feeds the ring modulation of a ring structure */
	mute?: boolean;
	wave: 'saw' | 'square' | 'attack' | 'loop' | 'noise';
	/** relative amplitudes of harmonics 1.. for `wave: 'loop'` (a looped PCM wave described by its spectrum) */
	loop?: readonly number[];
	/** an attack recipe to render for `wave: 'attack'`, instead of the bank entry `attack` */
	recipe?: D50Attack;
	/** index in `D50_ATTACKS` for `wave: 'attack'` (ignored when `pcm` is given) */
	attack?: number;
	/** the user's own PCM source: takes precedence over the synthesized attack bank */
	pcm?: PcmSource;
	/** the PCM wave number (77-100, a combination of waves 1-76) this partial asks for and the model plays with a stand-in */
	substituted?: number;
	pulseWidth?: number;
	pwmDepth?: number;
	pwmRate?: number;
	/** TVF: low-pass cut-off in Hz, resonance 0..1, envelope depth in octaves */
	cutoff: number;
	resonance?: number;
	filterDepth?: number;
	filterEnv?: BreakPoints;
	/** TVA amplitude envelope */
	amp: BreakPoints;
	/** WG pitch envelope as a frequency multiplier (1 = none); it holds its sustain level until the voice ends */
	pitchEnv?: BreakPoints;
	level?: number;
	detuneCents?: number;
	/** how far the pitch follows the key, relative to C4 (1 = standard, 0 = the same note on every key, -1 = inverted) */
	keyFollow?: number;
	/** how far the cut-off follows the key, relative to C4 (same scale) */
	filterKeyFollow?: number;
	/** how the tone's pitch LFO acts on this partial: 0 = not at all, 1 = as is (default), -1 = inverted */
	lfoSign?: number;
	/** skip the filter: the TVF applies to synthesised partials only, a PCM partial is not filtered */
	bypassFilter?: boolean;
}

export interface D50Lfo {
	/** rate in Hz */
	rate: number;
	/** pitch depth in cents, TVF depth in octaves, TVA depth 0..1 (each optional) */
	pitchCents?: number;
	filterOctaves?: number;
	ampDepth?: number;
	/** fade-in time in seconds */
	delay?: number;
}

export interface D50Tone {
	/** 1..7, selects how the two partials combine (mix gains / ring modulation), modelled on the D-50 structures */
	structure?: number;
	/** the tone LFO (the D-50 has three per tone; one combined LFO is modelled here) */
	lfo?: D50Lfo;
	partials: D50Partial[];
}

export interface D50Patch {
	/** one or two tones (the D-50's lower / upper), each of up to two partials */
	tones: D50Tone[];
	release?: number;
	chorus?: { rate?: number; depth?: number; mix: number };
	reverb?: { mix: number; feedback?: number };
}

/**
 * how each structure combines its two partials (Roland's D-50 structure chart): 1, 3 and 6 mix partial 1 and 2; 2, 4, 5
 * and 7 mix partial 1 with the ring modulation of the two. The gains are a modelling choice.
 */
const D50_STRUCTURES: readonly { gains: readonly [number, number]; ring: boolean }[] = [
	{ gains: [1, 1], ring: false },
	{ gains: [1, 1], ring: true },
	{ gains: [1, 0.6], ring: false },
	{ gains: [1, 0.6], ring: true },
	{ gains: [1, 0.8], ring: true },
	{ gains: [0.85, 0.85], ring: false },
	{ gains: [1, 0.5], ring: true },
];

const d50Env = {
	sustain: (level = 1, attack = 0.01): BreakPoints => [
		[0, 0],
		[attack, 1],
		[1, level],
	],
	decay: (seconds: number, tail = 0): BreakPoints => [
		[0, 0],
		[0.005, 1],
		[seconds, tail],
	],
	slow: (level = 0.8): BreakPoints => [
		[0, 0],
		[0.3, 1],
		[1, level],
	],
};

interface D50PartialExtra {
	wave?: never;
	attack?: number;
	pcm?: PcmSource;
	pulseWidth?: number;
	pwmDepth?: number;
	pwmRate?: number;
	resonance?: number;
	filterDepth?: number;
	filterEnv?: BreakPoints;
	pitchEnv?: BreakPoints;
	level?: number;
	detuneCents?: number;
}

const sawP = (cutoff: number, amp: BreakPoints, extra: D50PartialExtra = {}): D50Partial => ({
	wave: 'saw',
	cutoff,
	amp,
	...extra,
});
const atkP = (attack: number, cutoff: number, amp: BreakPoints, extra: D50PartialExtra = {}): D50Partial => ({
	wave: 'attack',
	attack,
	cutoff,
	amp,
	...extra,
});

/** playable LA patches built only from synth waves and the generated attack bank (no ROM content) */
export const D50_PRESETS: readonly { name: string; patch: D50Patch }[] = [
	{
		name: 'Digital Dream Pad',
		patch: {
			release: 0.6,
			chorus: { rate: 0.6, depth: 0.4, mix: 0.35 },
			reverb: { mix: 0.25, feedback: 0.55 },
			tones: [
				{
					structure: 1,
					partials: [sawP(2400, d50Env.slow()), sawP(3200, d50Env.slow(0.7), { detuneCents: 7 })],
				},
				{
					structure: 3,
					partials: [
						atkP(20, 6000, d50Env.decay(1.4, 0.25)),
						sawP(1800, d50Env.slow(0.6), { detuneCents: -6 }),
					],
				},
			],
		},
	},
	{
		name: 'Glass Voices',
		patch: {
			release: 0.5,
			chorus: { rate: 0.8, depth: 0.3, mix: 0.3 },
			reverb: { mix: 0.3, feedback: 0.6 },
			tones: [
				{
					structure: 1,
					partials: [atkP(20, 8000, d50Env.sustain(0.7, 0.05)), sawP(2600, d50Env.sustain(0.55, 0.08))],
				},
				{ structure: 3, partials: [atkP(15, 9000, d50Env.decay(1.8, 0.2)), sawP(3000, d50Env.slow(0.5))] },
			],
		},
	},
	{
		name: 'Warm String Ensemble',
		patch: {
			release: 0.4,
			chorus: { rate: 0.7, depth: 0.5, mix: 0.4 },
			tones: [
				{
					structure: 1,
					partials: [sawP(3600, d50Env.slow()), sawP(3600, d50Env.slow(0.8), { detuneCents: 8 })],
				},
				{
					structure: 1,
					partials: [
						sawP(3000, d50Env.slow(0.7), { detuneCents: -8 }),
						atkP(7, 5000, d50Env.decay(0.8, 0.3)),
					],
				},
			],
		},
	},
	{
		name: 'Analog Brass',
		patch: {
			release: 0.25,
			tones: [
				{
					structure: 2,
					partials: [
						sawP(2800, d50Env.sustain(0.85, 0.09), { filterDepth: 2, filterEnv: d50Env.decay(0.4, 0.4) }),
						sawP(2200, d50Env.sustain(0.7, 0.11), { detuneCents: 5 }),
					],
				},
			],
		},
	},
	{
		name: 'E.Piano Layers',
		patch: {
			release: 0.3,
			chorus: { rate: 0.5, depth: 0.35, mix: 0.3 },
			tones: [
				{ structure: 1, partials: [atkP(1, 9000, d50Env.decay(2.2)), sawP(2000, d50Env.decay(1.6, 0.15))] },
				{
					structure: 3,
					partials: [
						atkP(0, 7000, d50Env.decay(1.2), { level: 0.6 }),
						sawP(1500, d50Env.decay(2.5, 0.2), { level: 0.7 }),
					],
				},
			],
		},
	},
	{
		name: 'Breathy Flute',
		patch: {
			release: 0.3,
			reverb: { mix: 0.2, feedback: 0.45 },
			tones: [
				{
					structure: 1,
					partials: [
						atkP(9, 6000, d50Env.decay(0.25, 0.5)),
						{ wave: 'square', pulseWidth: 0.42, cutoff: 2400, amp: d50Env.sustain(0.75, 0.06), level: 0.8 },
					],
				},
			],
		},
	},
	{
		name: 'Pipe Organ',
		patch: {
			release: 0.6,
			reverb: { mix: 0.35, feedback: 0.65 },
			tones: [
				{
					structure: 1,
					partials: [
						sawP(4000, d50Env.sustain(1, 0.03)),
						sawP(4000, d50Env.sustain(0.7, 0.03), { detuneCents: 3 }),
					],
				},
				{
					structure: 3,
					partials: [
						atkP(15, 8000, d50Env.decay(1, 0.4)),
						sawP(5000, d50Env.sustain(0.6, 0.04), { level: 0.7 }),
					],
				},
			],
		},
	},
	{
		name: 'Orchestral Hit',
		patch: {
			release: 0.2,
			reverb: { mix: 0.3, feedback: 0.5 },
			tones: [
				{
					structure: 1,
					partials: [atkP(23, 12000, d50Env.decay(0.9)), sawP(5000, d50Env.decay(0.7), { level: 0.8 })],
				},
				{
					structure: 2,
					partials: [
						atkP(11, 10000, d50Env.decay(0.6), { level: 0.7 }),
						sawP(4000, d50Env.decay(0.8), { level: 0.7 }),
					],
				},
			],
		},
	},
];

interface D50PartialState {
	noiseState?: number;
	table?: Float32Array;
	tableHarmonics?: number;
	phase: number;
	lfoPhase: number;
	pcmPos: number;
	ampEnv: BreakPointEnvelope;
	filtEnv: BreakPointEnvelope;
	pitchEnv: BreakPointEnvelope | null;
	filter: LowPass;
	src: { data: Float32Array; rate: number; rootNote: number; loopStart?: number; loopEnd?: number } | null;
}

interface D50Voice {
	note: number;
	velocity: number;
	tones: D50PartialState[][];
	/** seconds since key-on and per-tone LFO phase, for the LFO delay fade-in */
	t: number;
	lfoPhase: number[];
	age: number;
	released: boolean;
}

/** small Schroeder reverb (4 combs + 2 allpasses) standing in for the D-50's digital reverb */
export class SimpleReverb {
	private readonly combs: { buf: Float32Array; idx: number; store: number }[];
	private readonly allpass: { buf: Float32Array; idx: number }[];

	constructor(rate: number, seedOffset = 0) {
		const scale = rate / 44100;
		this.combs = [1557, 1617, 1491, 1422].map((d) => ({
			buf: new Float32Array(Math.max(2, Math.floor((d + seedOffset) * scale))),
			idx: 0,
			store: 0,
		}));
		this.allpass = [556, 441].map((d) => ({
			buf: new Float32Array(Math.max(2, Math.floor((d + seedOffset) * scale))),
			idx: 0,
		}));
	}

	process(x: number, feedback: number): number {
		let s = 0;
		for (const c of this.combs) {
			const y = c.buf[c.idx];
			c.store = y * 0.28 + c.store * 0.72; // damping
			c.buf[c.idx] = x + c.store * feedback;
			c.idx = (c.idx + 1) % c.buf.length;
			s += y;
		}
		s *= 0.25;
		for (const a of this.allpass) {
			const y = a.buf[a.idx];
			const v = s + 0.5 * y;
			a.buf[a.idx] = v;
			a.idx = (a.idx + 1) % a.buf.length;
			s = y - 0.5 * v;
		}
		return s;
	}
}

/**
 * Roland D-50 / MT-32 family LA synthesis with **no ROM**: tones of two partials (WG synth waves or PCM attacks),
 * the 7 partial structures with ring modulation, TVF/TVA/pitch envelopes per partial, chorus and reverb. The PCM
 * attacks come from the generated `D50_ATTACKS` bank (or the user's own `PcmSource`): the sound is the closest
 * playable reconstruction of the LA logic, not the factory timbres, which live in the ROM we do not supply.
 */
export class D50Synth extends PolyBase {
	readonly id = 'd50';
	readonly name = 'Roland D-50 (LA synthesis, no ROM model)';
	preset = 0;
	private patch: D50Patch = D50_PRESETS[0].patch;
	private voices: D50Voice[] = [];
	private age = 0;
	private readonly maxVoices = 16;
	// effect state
	private chorusBuf = new Float32Array(8192);
	private chorusIdx = 0;
	private chorusPhase = 0;
	private reverbL = new SimpleReverb(this.sampleRate);
	private reverbR = new SimpleReverb(this.sampleRate, 23);

	loadPatch(patch: D50Patch): void {
		this.patch = patch;
	}

	selectPreset(index: number): void {
		const p = D50_PRESETS[index];
		if (!p) return;
		this.preset = index;
		this.loadPatch(p.patch);
	}

	get activeVoices(): number {
		return this.voices.length;
	}

	override write(addr: number, value: number): void {
		if (addr === 128) this.selectPreset(value);
		else super.write(addr, value);
	}

	reset(): void {
		this.voices = [];
		this.age = 0;
		this.chorusBuf = new Float32Array(8192);
		this.chorusIdx = 0;
		this.chorusPhase = 0;
		this.reverbL = new SimpleReverb(this.sampleRate);
		this.reverbR = new SimpleReverb(this.sampleRate, 23);
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		if (this.voices.length >= this.maxVoices) this.voices.shift();
		const release = this.patch.release ?? 0.3;
		this.voices.push({
			note,
			velocity: velocity / 127,
			tones: this.patch.tones.map((tone) => tone.partials.slice(0, 2).map((p) => this.makePartial(p, release))),
			t: 0,
			lfoPhase: this.patch.tones.map(() => 0),
			age: ++this.age,
			released: false,
		});
	}

	private makePartial(p: D50Partial, release: number): D50PartialState {
		const empty: BreakPoints = [
			[0, 1],
			[1, 1],
		];
		return {
			phase: 0,
			lfoPhase: 0,
			pcmPos: 0,
			ampEnv: new BreakPointEnvelope(p.amp, p.amp.length - 1, release),
			filtEnv: new BreakPointEnvelope(p.filterEnv ?? empty, (p.filterEnv ?? empty).length - 1, release),
			pitchEnv: p.pitchEnv ? new BreakPointEnvelope(p.pitchEnv, p.pitchEnv.length - 1, release) : null,
			filter: new LowPass(),
			src:
				p.wave === 'attack'
					? p.pcm
						? {
								data: p.pcm.data,
								rate: p.pcm.rate,
								rootNote: p.pcm.rootNote ?? 60,
								loopStart: p.pcm.loopStart,
								loopEnd: p.pcm.loopEnd,
							}
						: {
								data: p.recipe
									? renderAttackRecipe(p.recipe, this.sampleRate, noteHz(60), 22222)
									: synthAttackWave(p.attack ?? 0, this.sampleRate),
								rate: this.sampleRate,
								rootNote: 60,
							}
					: null,
		};
	}

	noteOff(note: number): void {
		for (const v of this.voices) {
			if (v.note === note && !v.released) {
				v.released = true;
				for (const tone of v.tones)
					for (const s of tone) {
						s.ampEnv.keyOff();
						s.filtEnv.keyOff();
					}
			}
		}
	}

	/** dry mono sample: tones summed, each tone combining its partials through its structure */
	protected sample(): number {
		const dt = 1 / this.sampleRate;
		let sum = 0;
		for (const v of this.voices) {
			v.t += dt;
			v.tones.forEach((tone, ti) => {
				const def = this.patch.tones[ti];
				const lfo = def.lfo;
				let mod = { pitch: 1, cutoff: 1, amp: 1 };
				if (lfo) {
					v.lfoPhase[ti] = (v.lfoPhase[ti] + lfo.rate * dt) % 1;
					const fade = lfo.delay ? Math.min(1, v.t / lfo.delay) : 1;
					const w = Math.sin(2 * Math.PI * v.lfoPhase[ti]) * fade;
					mod = {
						pitch: 2 ** (((lfo.pitchCents ?? 0) * w) / 1200),
						cutoff: 2 ** ((lfo.filterOctaves ?? 0) * w),
						amp: 1 - (lfo.ampDepth ?? 0) * (0.5 - 0.5 * w),
					};
				}
				const outs = tone.map((s, pi) => this.partialSample(v, s, def.partials[pi], dt, mod));
				if (outs.length < 2) {
					sum += (outs[0] ?? 0) * v.velocity;
					return;
				}
				const st = D50_STRUCTURES[Math.min(6, Math.max(0, (def.structure ?? 1) - 1))];
				const m0 = def.partials[0].mute ? 0 : 1;
				const m1 = def.partials[1].mute ? 0 : 1;
				const second = st.ring ? 2 * outs[0] * outs[1] * (m0 | m1) : outs[1] * m1;
				sum += (st.gains[0] * m0 * outs[0] + second * st.gains[1]) * v.velocity;
			});
		}
		this.voices = this.voices.filter((v) => !v.tones.every((t) => t.every((s) => s.ampEnv.done)));
		return sum * 0.35;
	}

	private partialSample(
		v: D50Voice,
		s: D50PartialState,
		p: D50Partial,
		dt: number,
		mod: { pitch: number; cutoff: number; amp: number },
	): number {
		const lfoPitch = p.lfoSign === undefined || p.lfoSign === 1 ? mod.pitch : p.lfoSign === 0 ? 1 : 1 / mod.pitch;
		const pitchMul = (s.pitchEnv ? s.pitchEnv.next(dt) : 1) * 2 ** ((p.detuneCents ?? 0) / 1200) * lfoPitch;
		const f = noteHz(60 + (v.note - 60) * (p.keyFollow ?? 1)) * pitchMul;
		let x: number;
		if (p.wave === 'attack' && s.src) {
			const src = s.src;
			s.pcmPos += (f / noteHz(src.rootNote)) * (src.rate / this.sampleRate);
			const end = src.loopEnd ?? src.data.length;
			if (s.pcmPos >= end && src.loopStart !== undefined)
				s.pcmPos = src.loopStart + ((s.pcmPos - end) % Math.max(1, end - src.loopStart));
			const i0 = Math.floor(s.pcmPos);
			x =
				i0 >= 0 && i0 < src.data.length - 1
					? src.data[i0] + (src.data[i0 + 1] - src.data[i0]) * (s.pcmPos - i0)
					: 0;
		} else if (p.wave === 'noise') {
			s.noiseState = ((s.noiseState ?? 0x9e3779b9) * 1664525 + 1013904223) >>> 0;
			x = (s.noiseState >>> 8) / 2 ** 23 - 1;
		} else if (p.wave === 'loop' && p.loop) {
			s.phase = (s.phase + f * dt) % 1;
			const harmonics = Math.floor((0.45 * this.sampleRate) / f);
			if (!s.table || s.tableHarmonics !== harmonics) {
				s.table = harmonicTable(p.loop, harmonics);
				s.tableHarmonics = harmonics;
			}
			const pos = s.phase * 2048;
			const i0 = Math.floor(pos);
			x = s.table[i0] + (s.table[i0 + 1] - s.table[i0]) * (pos - i0);
		} else {
			s.phase = (s.phase + f * dt) % 1;
			s.lfoPhase = (s.lfoPhase + (p.pwmRate ?? 0) * dt) % 1;
			if (p.wave === 'square') {
				const pw = Math.min(
					0.95,
					Math.max(0.05, (p.pulseWidth ?? 0.5) + (p.pwmDepth ?? 0) * Math.sin(2 * Math.PI * s.lfoPhase)),
				);
				x = s.phase < pw ? 1 : -1;
			} else x = 2 * s.phase - 1;
		}
		const filtLevel = s.filtEnv.next(dt);
		let filtered = x;
		if (!p.bypassFilter) {
			const keyOctaves = ((v.note - 60) * (p.filterKeyFollow ?? 0)) / 12;
			const cutoff = p.cutoff * 2 ** ((p.filterDepth ?? 0) * (filtLevel - 1) + keyOctaves) * mod.cutoff;
			filtered = s.filter.process(x, cutoff, 2 - 1.9 * (p.resonance ?? 0.1), this.sampleRate);
		}
		return filtered * s.ampEnv.next(dt) * (p.level ?? 1) * mod.amp;
	}

	override render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		if (this.muted) return;
		const chorus = this.patch.chorus;
		const reverb = this.patch.reverb;
		for (let i = 0; i < count; i++) {
			const dry = this.sample() * this.level;
			let l = dry;
			let r = dry;
			if (chorus && chorus.mix > 0) {
				this.chorusPhase = (this.chorusPhase + (chorus.rate ?? 0.6) / this.sampleRate) % 1;
				this.chorusBuf[this.chorusIdx] = dry;
				const delayMs = 14 + (chorus.depth ?? 0.4) * 6 * Math.sin(2 * Math.PI * this.chorusPhase);
				const read = (phase: number): number => {
					const d = Math.max(1, ((delayMs + phase) * this.sampleRate) / 1000);
					const pos = this.chorusIdx - d;
					const i0 = Math.floor(pos);
					const frac = pos - i0;
					const a = this.chorusBuf[((i0 % 8192) + 8192) % 8192];
					const b = this.chorusBuf[(((i0 + 1) % 8192) + 8192) % 8192];
					return a + (b - a) * frac;
				};
				l = dry + read(0) * chorus.mix;
				r = dry + read(2.5) * chorus.mix;
				this.chorusIdx = (this.chorusIdx + 1) % 8192;
			}
			if (reverb && reverb.mix > 0) {
				const fb = Math.min(0.85, reverb.feedback ?? 0.5);
				l += this.reverbL.process(dry, fb) * reverb.mix;
				r += this.reverbR.process(dry, fb) * reverb.mix;
			}
			left[start + i] += l;
			right[start + i] += r;
		}
	}
}

export { noteHz };

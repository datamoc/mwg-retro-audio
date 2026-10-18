import type { ChipOptions } from './Chip.ts';
import { PolyBase } from './historical.ts';

/**
 * Korg microKORG (1999) as a playable model, with no ROM and no sample: it is a virtual analogue ("analog modelling")
 * synthesizer, so its sound is computed, not stored. This models the architecture of one timbre, not the circuits:
 *
 * - oscillator 1 (saw, square with pulse width, triangle, sine or noise) and oscillator 2 (saw, square or triangle)
 *   with semitone and fine tuning, a sub-oscillator one octave down, a noise source and a mixer;
 * - oscillator 2 can be ring modulated by oscillator 1, hard synchronised to it, or both; a filter envelope can sweep
 *   its pitch (the classic synchronisation lead);
 * - a multimode resonant filter (24 dB and 12 dB low-pass, band-pass, high-pass) with key tracking and an envelope;
 * - ADSR envelopes for the filter and the amplifier, one LFO to pitch, cut-off, amplitude and pulse width, velocity;
 * - four voices, the oldest note stolen first, as on the instrument.
 *
 * Left out, and said so in `CONFORMANCE.md`: the vocoder and its microphone input, the tuner, the digital waveforms
 * (DWGS) and vox waves of oscillator 1, the arpeggiator, the mono and unison voice modes, the modulation, delay and
 * equaliser effects. The factory programs of the microKORG are not reproduced: `MICROKORG_PROGRAMS` holds original
 * programs written to evoke the families of sounds the instrument is known for.
 *
 * This file merges two implementations written at the same time: the engine and twelve of the programs are the first
 * one's, `Pulse poly`, `Soft flute` and `Analog EP`, the `program` constructor option and `selectProgram` come from
 * the second one (an OpenCode session), whose simpler 8 voice engine was dropped (the real instrument has four).
 */

export type MicroKorgWave = 'saw' | 'square' | 'triangle' | 'sine' | 'noise';
export type MicroKorgOsc2Wave = 'saw' | 'square' | 'triangle';
export type MicroKorgFilter = 'lp24' | 'lp12' | 'bp12' | 'hp12';
export type MicroKorgSync = 'off' | 'ring' | 'sync' | 'ring+sync';
export type MicroKorgLfoWave = 'triangle' | 'saw' | 'square' | 'random';

export interface MicroKorgAdsr {
	/** seconds */
	attack: number;
	/** seconds to fall most of the way to the sustain level */
	decay: number;
	/** level, 0..1 */
	sustain: number;
	/** seconds */
	release: number;
}

export interface MicroKorgProgram {
	osc1: { wave: MicroKorgWave; pulseWidth: number; octave: number; level: number };
	osc2: { wave: MicroKorgOsc2Wave; semitone: number; fine: number; level: number; sweep: number };
	/** oscillator 2 mode: plain, ring modulated by oscillator 1, hard synced to it, or both */
	sync: MicroKorgSync;
	sub: number;
	noise: number;
	filter: {
		type: MicroKorgFilter;
		cutoff: number;
		resonance: number;
		/** octaves of cut-off the filter envelope adds at its peak (negative closes the filter) */
		envAmount: number;
		keyTrack: number;
	};
	filterEnv: MicroKorgAdsr;
	ampEnv: MicroKorgAdsr;
	lfo: {
		wave: MicroKorgLfoWave;
		rate: number;
		pitchCents: number;
		cutoffOctaves: number;
		amp: number;
		pulseWidth: number;
		/** seconds before the LFO is at full depth */
		delay: number;
	};
	velocitySens: number;
}

const flat = (release: number): MicroKorgAdsr => ({ attack: 0.003, decay: 0.3, sustain: 1, release });

/** a program from a partial description, every other setting at a neutral value */
function program(over: {
	osc1?: Partial<MicroKorgProgram['osc1']>;
	osc2?: Partial<MicroKorgProgram['osc2']>;
	sync?: MicroKorgSync;
	sub?: number;
	noise?: number;
	filter?: Partial<MicroKorgProgram['filter']>;
	filterEnv?: Partial<MicroKorgAdsr>;
	ampEnv?: Partial<MicroKorgAdsr>;
	lfo?: Partial<MicroKorgProgram['lfo']>;
	velocitySens?: number;
}): MicroKorgProgram {
	return {
		osc1: { wave: 'saw', pulseWidth: 0.5, octave: 0, level: 0.8, ...over.osc1 },
		osc2: { wave: 'saw', semitone: 0, fine: 0, level: 0, sweep: 0, ...over.osc2 },
		sync: over.sync ?? 'off',
		sub: over.sub ?? 0,
		noise: over.noise ?? 0,
		filter: { type: 'lp24', cutoff: 3000, resonance: 0.2, envAmount: 0, keyTrack: 0.5, ...over.filter },
		filterEnv: { ...flat(0.2), ...over.filterEnv },
		ampEnv: { ...flat(0.2), ...over.ampEnv },
		lfo: {
			wave: 'triangle',
			rate: 5,
			pitchCents: 0,
			cutoffOctaves: 0,
			amp: 0,
			pulseWidth: 0,
			delay: 0,
			...over.lfo,
		},
		velocitySens: over.velocitySens ?? 0.5,
	};
}

export const MICROKORG_PROGRAMS: readonly { name: string; program: MicroKorgProgram }[] = [
	{
		name: 'Analog saw lead',
		program: program({
			osc2: { semitone: 0, fine: 9, level: 0.7 },
			filter: { cutoff: 2600, resonance: 0.25, envAmount: 1.2 },
			filterEnv: { attack: 0.004, decay: 0.35, sustain: 0.5, release: 0.25 },
			ampEnv: { attack: 0.005, decay: 0.3, sustain: 0.85, release: 0.25 },
			lfo: { rate: 5.5, pitchCents: 14, delay: 0.35 },
		}),
	},
	{
		name: 'Sync lead',
		program: program({
			sync: 'sync',
			osc2: { semitone: 5, level: 0.8, sweep: 9 },
			osc1: { level: 0.15 },
			filter: { cutoff: 5000, resonance: 0.15, envAmount: 0.5 },
			filterEnv: { attack: 0.002, decay: 0.7, sustain: 0.35, release: 0.3 },
			ampEnv: { attack: 0.004, decay: 0.2, sustain: 0.9, release: 0.2 },
			lfo: { rate: 5, pitchCents: 10, delay: 0.4 },
		}),
	},
	{
		name: 'Ring bell',
		program: program({
			sync: 'ring',
			osc1: { wave: 'sine', level: 0.55 },
			osc2: { wave: 'triangle', semitone: 17, fine: 18, level: 0.8 },
			filter: { type: 'lp12', cutoff: 9000, resonance: 0.1, keyTrack: 1 },
			ampEnv: { attack: 0.002, decay: 1.4, sustain: 0, release: 1.2 },
			filterEnv: { attack: 0.001, decay: 0.8, sustain: 0.2, release: 0.5 },
		}),
	},
	{
		name: 'Fat bass',
		program: program({
			osc2: { fine: -7, level: 0.7 },
			sub: 0.6,
			filter: { cutoff: 520, resonance: 0.3, envAmount: 2.6, keyTrack: 0.3 },
			filterEnv: { attack: 0.001, decay: 0.28, sustain: 0.3, release: 0.15 },
			ampEnv: { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.12 },
		}),
	},
	{
		name: 'Acid bass',
		program: program({
			osc1: { wave: 'square', pulseWidth: 0.45 },
			filter: { cutoff: 260, resonance: 0.82, envAmount: 3.6, keyTrack: 0.2 },
			filterEnv: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
			ampEnv: { attack: 0.001, decay: 0.4, sustain: 0.6, release: 0.08 },
		}),
	},
	{
		name: 'Warm pad',
		program: program({
			osc1: { wave: 'square', pulseWidth: 0.5, level: 0.6 },
			osc2: { fine: 12, level: 0.6 },
			filter: { type: 'lp12', cutoff: 1500, resonance: 0.15, envAmount: 0.8 },
			filterEnv: { attack: 0.8, decay: 1, sustain: 0.6, release: 1.2 },
			ampEnv: { attack: 0.7, decay: 0.6, sustain: 0.9, release: 1.4 },
			lfo: { rate: 0.35, pulseWidth: 0.25, pitchCents: 4, delay: 0.5 },
			velocitySens: 0.2,
		}),
	},
	{
		name: 'Analog brass',
		program: program({
			osc2: { fine: 6, level: 0.8 },
			filter: { cutoff: 700, resonance: 0.12, envAmount: 2.4, keyTrack: 0.6 },
			filterEnv: { attack: 0.07, decay: 0.3, sustain: 0.65, release: 0.2 },
			ampEnv: { attack: 0.05, decay: 0.2, sustain: 0.9, release: 0.18 },
			lfo: { rate: 5.2, pitchCents: 8, delay: 0.6 },
		}),
	},
	{
		name: 'Pluck',
		program: program({
			osc1: { wave: 'triangle', level: 0.7 },
			osc2: { wave: 'square', semitone: 12, level: 0.35 },
			filter: { type: 'lp12', cutoff: 1900, resonance: 0.2, envAmount: 3, keyTrack: 0.7 },
			filterEnv: { attack: 0.001, decay: 0.22, sustain: 0, release: 0.2 },
			ampEnv: { attack: 0.001, decay: 0.45, sustain: 0, release: 0.2 },
		}),
	},
	{
		name: 'Wobble bass',
		program: program({
			osc2: { fine: 5, level: 0.6 },
			sub: 0.5,
			filter: { cutoff: 380, resonance: 0.55, envAmount: 0.4, keyTrack: 0.2 },
			ampEnv: { attack: 0.003, decay: 0.2, sustain: 1, release: 0.12 },
			lfo: { wave: 'triangle', rate: 3.2, cutoffOctaves: 2.6 },
		}),
	},
	{
		name: 'Electric organ',
		program: program({
			osc1: { wave: 'sine', level: 0.7 },
			osc2: { wave: 'square', semitone: 12, level: 0.3 },
			filter: { type: 'lp12', cutoff: 6500, resonance: 0.05, keyTrack: 1 },
			ampEnv: { attack: 0.008, decay: 0.1, sustain: 1, release: 0.08 },
			lfo: { rate: 6.5, amp: 0.25 },
			velocitySens: 0.1,
		}),
	},
	{
		name: 'Noise sweep',
		program: program({
			osc1: { wave: 'noise', level: 0.9 },
			filter: { type: 'bp12', cutoff: 500, resonance: 0.65, envAmount: 3, keyTrack: 0.4 },
			filterEnv: { attack: 1.4, decay: 1.2, sustain: 0.2, release: 1.2 },
			ampEnv: { attack: 0.6, decay: 0.6, sustain: 0.8, release: 1.4 },
			velocitySens: 0.2,
		}),
	},
	{
		name: 'Soft strings',
		program: program({
			osc2: { fine: 14, level: 0.8 },
			filter: { type: 'lp12', cutoff: 2600, resonance: 0.1, keyTrack: 0.7 },
			ampEnv: { attack: 0.4, decay: 0.5, sustain: 1, release: 1 },
			lfo: { rate: 5, pitchCents: 6, delay: 0.7 },
			velocitySens: 0.25,
		}),
	},
	// the three programs below come from the OpenCode session's version, written again in this engine's terms
	{
		name: 'Pulse poly',
		program: program({
			osc1: { wave: 'square', pulseWidth: 0.25, level: 0.8 },
			osc2: { wave: 'square', semitone: -12, level: 0.5 },
			filter: { cutoff: 1600, resonance: 0.35, envAmount: 1.8, keyTrack: 0.25 },
			filterEnv: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.1 },
			ampEnv: { attack: 0.004, decay: 0.25, sustain: 0.6, release: 0.15 },
		}),
	},
	{
		name: 'Soft flute',
		program: program({
			osc1: { wave: 'triangle', level: 0.8 },
			filter: { type: 'lp12', cutoff: 1400, resonance: 0.1, envAmount: 0.4, keyTrack: 0.33 },
			filterEnv: { attack: 0.15, decay: 0.4, sustain: 0.6, release: 0.2 },
			ampEnv: { attack: 0.12, decay: 0.6, sustain: 0.85, release: 0.35 },
			lfo: { rate: 4.8, pitchCents: 12 },
			velocitySens: 0.3,
		}),
	},
	{
		name: 'Analog EP',
		program: program({
			sync: 'ring',
			osc1: { wave: 'triangle', level: 0.6 },
			osc2: { wave: 'saw', semitone: 12, fine: 3, level: 0.25 },
			filter: { cutoff: 2000, resonance: 0.2, envAmount: 1.4, keyTrack: 0.42 },
			filterEnv: { attack: 0.003, decay: 0.35, sustain: 0.1, release: 0.2 },
			ampEnv: { attack: 0.003, decay: 0.9, sustain: 0.35, release: 0.5 },
			lfo: { rate: 4.2 },
		}),
	},
];

const TWO_PI = Math.PI * 2;
const noteHz = (n: number): number => 440 * 2 ** ((n - 69) / 12);

/** the band-limited step correction of a saw or square edge (PolyBLEP), `t` the phase, `dt` the phase increment */
function polyBlep(t: number, dt: number): number {
	if (t < dt) {
		const x = t / dt;
		return x + x - x * x - 1;
	}
	if (t > 1 - dt) {
		const x = (t - 1) / dt;
		return x * x + x + x + 1;
	}
	return 0;
}

function wave(kind: MicroKorgWave, phase: number, dt: number, pulseWidth: number, noise: () => number): number {
	switch (kind) {
		case 'saw':
			return 2 * phase - 1 - polyBlep(phase, dt);
		case 'square': {
			const pw = Math.min(0.95, Math.max(0.05, pulseWidth));
			return (phase < pw ? 1 : -1) + polyBlep(phase, dt) - polyBlep((phase + 1 - pw) % 1, dt);
		}
		case 'triangle':
			return 4 * Math.abs(phase - 0.5) - 1;
		case 'sine':
			return Math.sin(TWO_PI * phase);
		default:
			return noise();
	}
}

/** a trapezoidal state variable filter: stable at any cut-off, with low-pass, band-pass and high-pass outputs */
class StateVariable {
	private ic1 = 0;
	private ic2 = 0;
	process(x: number, cutoffHz: number, damping: number, rate: number): { lp: number; bp: number; hp: number } {
		const g = Math.tan((Math.PI * Math.min(cutoffHz, rate * 0.45)) / rate);
		const a1 = 1 / (1 + g * (g + damping));
		const a2 = g * a1;
		const a3 = g * a2;
		const v3 = x - this.ic2;
		const v1 = a1 * this.ic1 + a2 * v3;
		const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
		this.ic1 = 2 * v1 - this.ic1;
		this.ic2 = 2 * v2 - this.ic2;
		return { lp: v2, bp: v1, hp: x - damping * v1 - v2 };
	}
}

const enum Stage {
	Attack,
	Decay,
	Sustain,
	Release,
	Done,
}

/** an ADSR with a linear attack and exponential decay and release */
class Adsr {
	private stage = Stage.Attack;
	private value = 0;
	constructor(private readonly shape: MicroKorgAdsr) {}
	keyOff(): void {
		if (this.stage !== Stage.Done) this.stage = Stage.Release;
	}
	get done(): boolean {
		return this.stage === Stage.Done;
	}
	next(dt: number): number {
		const s = this.shape;
		switch (this.stage) {
			case Stage.Attack:
				this.value += dt / Math.max(1e-4, s.attack);
				if (this.value >= 1) {
					this.value = 1;
					this.stage = Stage.Decay;
				}
				break;
			case Stage.Decay:
				this.value = s.sustain + (this.value - s.sustain) * Math.exp(-dt * (4.6 / Math.max(1e-3, s.decay)));
				if (this.value - s.sustain < 1e-3) {
					this.value = s.sustain;
					this.stage = Stage.Sustain;
				}
				break;
			case Stage.Sustain:
				this.value = s.sustain;
				break;
			case Stage.Release:
				this.value *= Math.exp(-dt * (4.6 / Math.max(1e-3, s.release)));
				if (this.value < 1e-4) {
					this.value = 0;
					this.stage = Stage.Done;
				}
				break;
			default:
				return 0;
		}
		return this.value;
	}
}

interface Voice {
	note: number;
	velocity: number;
	phase1: number;
	phase2: number;
	phaseSub: number;
	filterA: StateVariable;
	filterB: StateVariable;
	ampEnv: Adsr;
	filterEnv: Adsr;
	lfoPhase: number;
	lfoHold: number;
	time: number;
	age: number;
	released: boolean;
}

/** Korg microKORG model without ROM: see the header of this file */
export class MicroKorgSynth extends PolyBase {
	readonly id = 'microkorg';
	readonly name = 'Korg microKORG (virtual analogue model)';
	preset = 0;
	private current: MicroKorgProgram = structuredClone(MICROKORG_PROGRAMS[0].program);
	private voices: Voice[] = [];
	private age = 0;
	private readonly maxVoices = 4;
	private seed = 0x1234567;

	constructor(options: ChipOptions & { level?: number; program?: number } = {}) {
		super(options);
		if (options.program !== undefined) this.selectPreset(options.program);
	}

	loadProgram(program: MicroKorgProgram): void {
		this.current = program;
	}

	/** switch to a factory program: the chip gets its own copy, editing it leaves `MICROKORG_PROGRAMS` alone */
	selectPreset(index: number): void {
		const entry = MICROKORG_PROGRAMS[index];
		if (!entry) return;
		this.preset = index;
		this.loadProgram(structuredClone(entry.program));
	}

	/** the same as `selectPreset` */
	selectProgram(index: number): void {
		this.selectPreset(index);
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
		this.seed = 0x1234567;
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		this.voices = this.voices.filter((voice) => !(voice.note === note && !voice.released));
		if (this.voices.length >= this.maxVoices) this.voices.shift();
		const p = this.current;
		this.voices.push({
			note,
			velocity: velocity / 127,
			phase1: 0,
			phase2: 0,
			phaseSub: 0,
			filterA: new StateVariable(),
			filterB: new StateVariable(),
			ampEnv: new Adsr(p.ampEnv),
			filterEnv: new Adsr(p.filterEnv),
			lfoPhase: 0,
			lfoHold: 0,
			time: 0,
			age: ++this.age,
			released: false,
		});
	}

	noteOff(note: number): void {
		for (const voice of this.voices) {
			if (voice.note === note && !voice.released) {
				voice.released = true;
				voice.ampEnv.keyOff();
				voice.filterEnv.keyOff();
			}
		}
	}

	private noise = (): number => {
		this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
		return this.seed / 2 ** 31 - 1;
	};

	protected sample(): number {
		const rate = this.sampleRate;
		const dt = 1 / rate;
		const p = this.current;
		let sum = 0;
		for (const voice of this.voices) {
			voice.time += dt;
			const filterLevel = voice.filterEnv.next(dt);
			// LFO
			const previous = voice.lfoPhase;
			voice.lfoPhase = (voice.lfoPhase + p.lfo.rate * dt) % 1;
			if (voice.lfoPhase < previous) voice.lfoHold = this.noise();
			const fade = p.lfo.delay > 0 ? Math.min(1, voice.time / p.lfo.delay) : 1;
			let lfo: number;
			switch (p.lfo.wave) {
				case 'saw':
					lfo = 1 - 2 * voice.lfoPhase;
					break;
				case 'square':
					lfo = voice.lfoPhase < 0.5 ? 1 : -1;
					break;
				case 'random':
					lfo = voice.lfoHold;
					break;
				default:
					lfo = 4 * Math.abs(voice.lfoPhase - 0.5) - 1;
			}
			lfo *= fade;
			// oscillators
			const bend = 2 ** ((p.lfo.pitchCents * lfo) / 1200);
			const f1 = noteHz(voice.note + 12 * p.osc1.octave) * bend;
			const f2 = noteHz(voice.note + p.osc2.semitone + p.osc2.sweep * filterLevel + p.osc2.fine / 100) * bend;
			const dt1 = Math.min(0.49, f1 * dt);
			const dt2 = Math.min(0.49, f2 * dt);
			voice.phase1 += f1 * dt;
			if (voice.phase1 >= 1) {
				voice.phase1 -= 1;
				if (p.sync === 'sync' || p.sync === 'ring+sync') voice.phase2 = voice.phase1 * (f2 / f1);
			}
			voice.phase2 = (voice.phase2 + f2 * dt) % 1;
			voice.phaseSub = (voice.phaseSub + f1 * 0.5 * dt) % 1;
			const pulse = p.osc1.pulseWidth + p.lfo.pulseWidth * lfo;
			const o1 = wave(p.osc1.wave, voice.phase1, dt1, pulse, this.noise);
			const o2 = wave(p.osc2.wave, voice.phase2, dt2, pulse, this.noise);
			const ring = p.sync === 'ring' || p.sync === 'ring+sync';
			let x = o1 * p.osc1.level + (ring ? o1 * o2 : o2) * p.osc2.level;
			if (p.sub > 0) x += wave('square', voice.phaseSub, dt1 * 0.5, 0.5, this.noise) * p.sub * 0.8;
			if (p.noise > 0) x += this.noise() * p.noise;
			// filter
			const keyOctaves = ((voice.note - 60) / 12) * p.filter.keyTrack;
			const velocityOctaves = p.velocitySens * (voice.velocity - 1);
			const cutoff = Math.min(
				20000,
				Math.max(
					20,
					p.filter.cutoff *
						2 **
							(keyOctaves +
								p.filter.envAmount * filterLevel +
								p.lfo.cutoffOctaves * lfo +
								velocityOctaves),
				),
			);
			const damping = 2 - 1.96 * Math.min(1, Math.max(0, p.filter.resonance));
			const first = voice.filterA.process(x, cutoff, damping, rate);
			let y: number;
			switch (p.filter.type) {
				case 'lp24':
					y = voice.filterB.process(first.lp, cutoff, damping, rate).lp;
					break;
				case 'bp12':
					y = first.bp * 0.8;
					break;
				case 'hp12':
					y = first.hp;
					break;
				default:
					y = first.lp;
			}
			const velocityGain = 1 - p.velocitySens + p.velocitySens * voice.velocity;
			const tremolo = 1 - p.lfo.amp * (0.5 - 0.5 * lfo);
			sum += y * voice.ampEnv.next(dt) * velocityGain * tremolo;
		}
		this.voices = this.voices.filter((voice) => !voice.ampEnv.done);
		return Math.tanh(sum * 0.5);
	}
}

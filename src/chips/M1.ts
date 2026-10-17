import {
	BreakPointEnvelope,
	LowPass,
	PolyBase,
	harmonicTable,
	SimpleReverb,
	noteHz,
	renderAttackRecipe,
	type BreakPoints,
} from './historical.ts';
import { M1_ATTACKS, M1_LOOPS } from './m1Data.ts';

/**
 * Korg M1 (1988, AI synthesis) with **no ROM**. The real machine plays 16 bit PCM multisamples (an attack part and a
 * looped part) through a resonant filter and an amplifier, two oscillators per program, then a digital effects unit.
 * The same decomposition is kept here, but the two PCM parts are *generated*:
 *
 * - the looped part is a single-cycle table summed from the 16 harmonic amplitudes of `M1_LOOPS`, averaged
 *   steady-state spectra measured on the M1's sample ROM;
 * - the attack part is a short transient rendered from a `M1_ATTACKS` recipe (decaying partials and a noise burst),
 *   fitted on the same ROM.
 *
 * Both tables hold only a few averaged numbers per entry (see `tools/rom-analysis`); no ROM byte, sample or wavecycle is
 * part of the package, and the factory programs of the M1 are not reproduced: `M1_PRESETS` are archetypal programs
 * written for this package, named by the family of sound they aim at.
 */

export interface M1Osc {
	/** index in `M1_LOOPS` (0 = brightest steady spectrum, 15 = nearly a sine) */
	loop: number;
	/** index in `M1_ATTACKS`: an optional one-shot transient played at the start of the note */
	attack?: number;
	attackLevel?: number;
	/** transposition in octaves */
	octave?: number;
	detuneCents?: number;
	level?: number;
}

export interface M1Lfo {
	/** rate in Hz */
	rate: number;
	/** pitch depth in cents and filter depth in octaves */
	pitchCents?: number;
	filterOctaves?: number;
	/** seconds before the LFO reaches full depth */
	delay?: number;
}

export interface M1Program {
	/** one or two oscillators */
	oscs: M1Osc[];
	/** VCF: cut-off in Hz at note 60, resonance 0..1, how far the cut-off follows the key (0..1), envelope depth in octaves */
	cutoff: number;
	resonance?: number;
	keyTrack?: number;
	filterDepth?: number;
	filterEnv?: BreakPoints;
	/** VCA envelope */
	amp: BreakPoints;
	release?: number;
	/** 0..1: how much the velocity scales the level and opens the filter */
	velocitySens?: number;
	lfo?: M1Lfo;
	chorus?: { mix: number; rate?: number; depth?: number };
	reverb?: { mix: number; feedback?: number };
}

const attackIndex = (name: string): number => {
	const i = M1_ATTACKS.findIndex((a) => a.name === name);
	if (i < 0) throw new Error(`no M1 attack named ${name}`);
	return i;
};

const TABLE = 2048;

const attackWaves = new Map<string, Float32Array>();

function attackWave(index: number, rate: number): Float32Array {
	const key = `${index}@${rate}`;
	const cached = attackWaves.get(key);
	if (cached) return cached;
	const w = renderAttackRecipe(M1_ATTACKS[index], rate, noteHz(60), 4444 + index * 977);
	attackWaves.set(key, w);
	return w;
}

const env = {
	/** quick attack, decays to `sustain` over `decay` seconds */
	decay: (decay: number, sustain = 0, attack = 0.004): BreakPoints => [
		[0, 0],
		[attack, 1],
		[attack + decay, sustain],
	],
	/** swells in over `attack` seconds and holds */
	swell: (attack: number, level = 1): BreakPoints => [
		[0, 0],
		[attack, level],
	],
	/** attack, small decay, held at `sustain` */
	sustain: (sustain: number, attack = 0.01, decay = 0.2): BreakPoints => [
		[0, 0],
		[attack, 1],
		[attack + decay, sustain],
	],
};

const osc = (loop: number, extra: Partial<M1Osc> = {}): M1Osc => ({ loop, ...extra });

export const M1_PRESETS: readonly { name: string; program: M1Program }[] = [
	{
		name: 'Piano',
		program: {
			oscs: [
				osc(7, { attack: attackIndex('Piano Hammer'), attackLevel: 0.5 }),
				osc(11, { level: 0.5, detuneCents: 3 }),
			],
			cutoff: 5000,
			keyTrack: 0.6,
			filterDepth: 1.5,
			filterEnv: env.decay(0.6, 0.35),
			amp: env.decay(2.6, 0.04),
			velocitySens: 0.8,
			reverb: { mix: 0.18 },
		},
	},
	{
		name: 'Electric Piano',
		program: {
			oscs: [
				osc(11, { attack: attackIndex('Steel Drum'), attackLevel: 0.35 }),
				osc(14, { octave: 1, level: 0.3 }),
			],
			cutoff: 4500,
			keyTrack: 0.5,
			filterDepth: 1,
			filterEnv: env.decay(0.5, 0.4),
			amp: env.decay(2, 0.12),
			velocitySens: 0.7,
			chorus: { mix: 0.35 },
		},
	},
	{
		name: 'Strings',
		program: {
			oscs: [osc(4, { detuneCents: -6 }), osc(1, { detuneCents: 7, level: 0.7 })],
			cutoff: 3000,
			keyTrack: 0.7,
			filterDepth: 0.8,
			filterEnv: env.swell(0.5),
			amp: env.swell(0.45),
			release: 0.5,
			velocitySens: 0.3,
			lfo: { rate: 5.2, pitchCents: 5, delay: 0.6 },
			chorus: { mix: 0.45, rate: 0.5 },
			reverb: { mix: 0.25 },
		},
	},
	{
		name: 'Brass',
		program: {
			oscs: [
				osc(1, { attack: attackIndex('Trumpet Blast'), attackLevel: 0.4 }),
				osc(6, { detuneCents: 4, level: 0.7 }),
			],
			cutoff: 1800,
			keyTrack: 0.8,
			filterDepth: 2.2,
			filterEnv: env.sustain(0.55, 0.06, 0.25),
			amp: env.sustain(0.85, 0.05, 0.2),
			release: 0.25,
			velocitySens: 0.7,
			lfo: { rate: 5.5, pitchCents: 7, delay: 0.5 },
			reverb: { mix: 0.15 },
		},
	},
	{
		name: 'Organ',
		program: {
			oscs: [osc(3), osc(13, { octave: 1, level: 0.5 })],
			cutoff: 9000,
			keyTrack: 1,
			amp: env.sustain(1, 0.008, 0.01),
			release: 0.05,
			velocitySens: 0,
			lfo: { rate: 6.5, pitchCents: 4, filterOctaves: 0 },
			chorus: { mix: 0.3, rate: 0.8 },
		},
	},
	{
		name: 'Synth Bass',
		program: {
			oscs: [osc(6, { octave: -1 }), osc(13, { octave: -2, level: 0.8 })],
			cutoff: 700,
			resonance: 0.35,
			keyTrack: 0.5,
			filterDepth: 2.6,
			filterEnv: env.decay(0.22, 0.15, 0.003),
			amp: env.sustain(0.7, 0.003, 0.3),
			release: 0.12,
			velocitySens: 0.6,
		},
	},
	{
		name: 'Flute',
		program: {
			oscs: [
				osc(14, { attack: attackIndex('Flute Chiff'), attackLevel: 0.3 }),
				osc(13, { octave: 1, level: 0.25 }),
			],
			cutoff: 4000,
			keyTrack: 0.8,
			amp: env.sustain(0.85, 0.07, 0.15),
			release: 0.2,
			velocitySens: 0.4,
			lfo: { rate: 5, pitchCents: 8, delay: 0.5 },
			reverb: { mix: 0.25 },
		},
	},
	{
		name: 'Choir',
		program: {
			oscs: [osc(12, { detuneCents: -5 }), osc(11, { octave: 1, detuneCents: 6, level: 0.5 })],
			cutoff: 2200,
			keyTrack: 0.7,
			filterDepth: 0.7,
			filterEnv: env.swell(0.6),
			amp: env.swell(0.55),
			release: 0.6,
			velocitySens: 0.2,
			lfo: { rate: 4.6, pitchCents: 6, delay: 0.8 },
			chorus: { mix: 0.5, rate: 0.4 },
			reverb: { mix: 0.35, feedback: 0.6 },
		},
	},
	{
		name: 'Acoustic Guitar',
		program: {
			oscs: [osc(9, { attack: attackIndex('Acoustic Guitar Pick'), attackLevel: 0.6 }), osc(10, { level: 0.5 })],
			cutoff: 4200,
			keyTrack: 0.7,
			filterDepth: 1.2,
			filterEnv: env.decay(0.5, 0.3),
			amp: env.decay(1.6, 0.02),
			release: 0.15,
			velocitySens: 0.7,
			chorus: { mix: 0.2 },
		},
	},
	{
		name: 'Marimba',
		program: {
			oscs: [
				osc(13, { attack: attackIndex('Vibraphone Mallet'), attackLevel: 0.5 }),
				osc(8, { octave: 2, level: 0.15 }),
			],
			cutoff: 6000,
			keyTrack: 0.6,
			amp: env.decay(0.55, 0.0),
			release: 0.1,
			velocitySens: 0.8,
		},
	},
	{
		name: 'Clavi',
		program: {
			oscs: [osc(5, { attack: attackIndex('Harpsichord Plectrum'), attackLevel: 0.5 }), osc(6, { level: 0.6 })],
			cutoff: 3500,
			resonance: 0.2,
			keyTrack: 0.8,
			filterDepth: 2,
			filterEnv: env.decay(0.25, 0.25),
			amp: env.decay(0.9, 0.1),
			release: 0.08,
			velocitySens: 0.7,
		},
	},
	{
		name: 'Pad',
		program: {
			oscs: [osc(4, { detuneCents: -9 }), osc(7, { detuneCents: 9, level: 0.8 })],
			cutoff: 1800,
			resonance: 0.15,
			keyTrack: 0.5,
			filterDepth: 1.5,
			filterEnv: [
				[0, 0.2],
				[1.2, 1],
				[3, 0.5],
			],
			amp: env.swell(0.9),
			release: 0.9,
			velocitySens: 0.2,
			lfo: { rate: 0.3, filterOctaves: 0.5 },
			chorus: { mix: 0.5 },
			reverb: { mix: 0.4, feedback: 0.65 },
		},
	},
	{
		name: 'Bell',
		program: {
			oscs: [
				osc(2, { attack: attackIndex('Bell Strike'), attackLevel: 0.7, octave: 1 }),
				osc(8, { octave: 2, level: 0.2, detuneCents: 12 }),
			],
			cutoff: 9000,
			keyTrack: 1,
			amp: env.decay(2.8, 0),
			release: 0.4,
			velocitySens: 0.6,
			reverb: { mix: 0.3 },
		},
	},
	{
		name: 'Sax',
		program: {
			oscs: [
				osc(10, { attack: attackIndex('Sax Growl'), attackLevel: 0.35 }),
				osc(4, { level: 0.5, detuneCents: 5 }),
			],
			cutoff: 2200,
			resonance: 0.15,
			keyTrack: 0.8,
			filterDepth: 1.2,
			filterEnv: env.sustain(0.6, 0.05, 0.2),
			amp: env.sustain(0.85, 0.04, 0.15),
			release: 0.18,
			velocitySens: 0.6,
			lfo: { rate: 5.3, pitchCents: 9, delay: 0.4 },
			reverb: { mix: 0.15 },
		},
	},
	{
		name: 'Harp',
		program: {
			oscs: [
				osc(14, { attack: attackIndex('Nylon Pluck'), attackLevel: 0.5 }),
				osc(13, { octave: 1, level: 0.2 }),
			],
			cutoff: 5000,
			keyTrack: 0.8,
			amp: env.decay(1.8, 0),
			release: 0.3,
			velocitySens: 0.6,
			reverb: { mix: 0.3 },
		},
	},
	{
		name: 'Synth Lead',
		program: {
			oscs: [osc(1, { detuneCents: -7 }), osc(6, { detuneCents: 7, level: 0.7 })],
			cutoff: 3200,
			resonance: 0.3,
			keyTrack: 0.9,
			filterDepth: 1.8,
			filterEnv: env.sustain(0.5, 0.01, 0.3),
			amp: env.sustain(0.9, 0.01, 0.1),
			release: 0.15,
			velocitySens: 0.5,
			lfo: { rate: 5.8, pitchCents: 10, delay: 0.35 },
			chorus: { mix: 0.3 },
		},
	},
];

interface M1OscState {
	/** the loop table in use and the number of harmonics it was built with (rebuilt only when the pitch moves it) */
	table: Float32Array | null;
	tableHarmonics: number;
	phase: number;
	attackPos: number;
	attack: Float32Array | null;
}

interface M1Voice {
	/** the program the voice was started with: a program change does not disturb sounding notes */
	program: M1Program;
	note: number;
	velocity: number;
	oscs: M1OscState[];
	ampEnv: BreakPointEnvelope;
	filtEnv: BreakPointEnvelope;
	filter: LowPass;
	t: number;
	lfoPhase: number;
	age: number;
	released: boolean;
}

/** Korg M1 (AI synthesis) model without its ROM: see the header of this file */
export class M1Synth extends PolyBase {
	readonly id = 'm1';
	readonly name = 'Korg M1 (AI synthesis, no ROM model)';
	preset = 0;
	private program: M1Program = M1_PRESETS[0].program;
	private voices: M1Voice[] = [];
	private age = 0;
	private readonly maxVoices = 16;
	private chorusBuf = new Float32Array(8192);
	private chorusIdx = 0;
	private chorusPhase = 0;
	private reverbL = new SimpleReverb(this.sampleRate);
	private reverbR = new SimpleReverb(this.sampleRate, 23);

	loadProgram(program: M1Program): void {
		this.program = program;
	}

	selectPreset(index: number): void {
		const p = M1_PRESETS[index];
		if (!p) return;
		this.preset = index;
		this.loadProgram(p.program);
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
		this.chorusBuf = new Float32Array(8192);
		this.chorusIdx = 0;
		this.reverbL = new SimpleReverb(this.sampleRate);
		this.reverbR = new SimpleReverb(this.sampleRate, 23);
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		if (this.voices.length >= this.maxVoices) this.voices.shift();
		const p = this.program;
		const release = p.release ?? 0.3;
		const flat: BreakPoints = [
			[0, 1],
			[1, 1],
		];
		this.voices.push({
			program: p,
			note,
			velocity: velocity / 127,
			oscs: p.oscs.slice(0, 2).map((o) => ({
				table: null,
				tableHarmonics: 0,
				phase: 0,
				attackPos: 0,
				attack: o.attack === undefined ? null : attackWave(o.attack, this.sampleRate),
			})),
			ampEnv: new BreakPointEnvelope(p.amp, p.amp.length - 1, release),
			filtEnv: new BreakPointEnvelope(p.filterEnv ?? flat, (p.filterEnv ?? flat).length - 1, release),
			filter: new LowPass(),
			t: 0,
			lfoPhase: 0,
			age: ++this.age,
			released: false,
		});
	}

	noteOff(note: number): void {
		for (const v of this.voices) {
			if (v.note === note && !v.released) {
				v.released = true;
				v.ampEnv.keyOff();
				v.filtEnv.keyOff();
			}
		}
	}

	protected sample(): number {
		const dt = 1 / this.sampleRate;
		let sum = 0;
		for (const v of this.voices) {
			const p = v.program;
			const vs = p.velocitySens ?? 0.5;
			v.t += dt;
			let pitchMod = 1;
			let cutoffMod = 1;
			if (p.lfo) {
				v.lfoPhase = (v.lfoPhase + p.lfo.rate * dt) % 1;
				const fade = p.lfo.delay ? Math.min(1, v.t / p.lfo.delay) : 1;
				const w = Math.sin(2 * Math.PI * v.lfoPhase) * fade;
				pitchMod = 2 ** (((p.lfo.pitchCents ?? 0) * w) / 1200);
				cutoffMod = 2 ** ((p.lfo.filterOctaves ?? 0) * w);
			}
			let x = 0;
			for (let i = 0; i < v.oscs.length; i++) {
				const o = p.oscs[i];
				const s = v.oscs[i];
				const f = noteHz(v.note + 12 * (o.octave ?? 0)) * 2 ** ((o.detuneCents ?? 0) / 1200) * pitchMod;
				const harmonics = Math.min(16, Math.floor((0.45 * this.sampleRate) / f));
				if (!s.table || s.tableHarmonics !== harmonics) {
					s.table = harmonicTable(
						M1_LOOPS[Math.max(0, Math.min(M1_LOOPS.length - 1, o.loop | 0))],
						harmonics,
					);
					s.tableHarmonics = harmonics;
				}
				const table = s.table;
				s.phase = (s.phase + f * dt) % 1;
				const pos = s.phase * TABLE;
				const i0 = Math.floor(pos);
				x += (table[i0] + (table[i0 + 1] - table[i0]) * (pos - i0)) * (o.level ?? 1);
				if (s.attack) {
					s.attackPos += noteHz(v.note) / noteHz(60);
					const a0 = Math.floor(s.attackPos);
					if (a0 < s.attack.length - 1)
						x +=
							(s.attack[a0] + (s.attack[a0 + 1] - s.attack[a0]) * (s.attackPos - a0)) *
							(o.attackLevel ?? 0.5);
				}
			}
			const velGain = 1 - vs + vs * v.velocity;
			const keyOctaves = ((v.note - 60) / 12) * (p.keyTrack ?? 0.5);
			const cutoff =
				p.cutoff *
				2 ** (keyOctaves + (p.filterDepth ?? 0) * (v.filtEnv.next(dt) - 1) + vs * (v.velocity - 1)) *
				cutoffMod;
			const filtered = v.filter.process(x, cutoff, 2 - 1.9 * (p.resonance ?? 0.1), this.sampleRate);
			sum += filtered * v.ampEnv.next(dt) * velGain;
		}
		this.voices = this.voices.filter((v) => !v.ampEnv.done);
		return sum * 0.4;
	}

	override render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		if (this.muted) return;
		const { chorus, reverb } = this.program;
		for (let i = 0; i < count; i++) {
			const dry = this.sample() * this.level;
			let l = dry;
			let r = dry;
			if (chorus && chorus.mix > 0) {
				this.chorusPhase = (this.chorusPhase + (chorus.rate ?? 0.6) / this.sampleRate) % 1;
				this.chorusBuf[this.chorusIdx] = dry;
				const delayMs = 14 + (chorus.depth ?? 0.4) * 6 * Math.sin(2 * Math.PI * this.chorusPhase);
				const read = (offsetMs: number): number => {
					const pos = this.chorusIdx - Math.max(1, ((delayMs + offsetMs) * this.sampleRate) / 1000);
					const i0 = Math.floor(pos);
					const a = this.chorusBuf[((i0 % 8192) + 8192) % 8192];
					const b = this.chorusBuf[(((i0 + 1) % 8192) + 8192) % 8192];
					return a + (b - a) * (pos - i0);
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

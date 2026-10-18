import type { Chip, ChipOptions } from './Chip.ts';

/**
 * Korg microKORG (1999): a two-oscillator virtual-analog poly with a multimode analog-modelled
 * filter, per-voice amp and filter envelopes, a shared LFO and a vocoder. Modelled without ROM
 * and without samples, like the other historical synths here: the oscillator shapes are naive
 * band-limited-ish waves, the envelopes are linear segments, the filter is a state-variable
 * cell. 8 voices, one channel at a time like the hardware. The vocoder needs a microphone and
 * stays out of the note engine; the arpeggiator and the modulator routing of the real unit are
 * reduced to the pitch and filter depths below.
 */

export type MicroKorgWave = 'saw' | 'square' | 'triangle' | 'noise';

export interface MicroKorgPatch {
	osc1: MicroKorgWave;
	osc2: MicroKorgWave | 'off';
	/** octave shift of oscillator 2 (-2..+2), and its detune in cents */
	osc2Octave: number;
	detune: number;
	osc2Level: number;
	sync: boolean;
	ring: boolean;
	/** pulse width of every square wave, 0.05..0.95 */
	pulseWidth: number;
	/** VCF: mode, cut-off in Hz, resonance 0..1, key track in cents per octave, env depth in octaves */
	filterMode: 'LP' | 'HP' | 'BP';
	cutoff: number;
	resonance: number;
	keyTrack: number;
	envToFilter: number;
	/** filter AHDSR: times in seconds, sustain as a level 0..1 */
	filterAttack: number;
	filterDecay: number;
	filterSustain: number;
	filterRelease: number;
	/** amplifier AHDSR */
	ampAttack: number;
	ampDecay: number;
	ampSustain: number;
	ampRelease: number;
	/** shared LFO: rate in Hz, depth on the pitch in cents and on the cut-off in semitones */
	lfoRate: number;
	lfoPitch: number;
	lfoFilter: number;
	/** 0..1 */
	volume: number;
}

interface Voice {
	note: number;
	velocity: number;
	phase1: number;
	phase2: number;
	/** envelope states (seconds since the key on, release since the key off) */
	ampT: number;
	fltT: number;
	released: boolean;
	releaseFromAmp: number;
	releaseFromFlt: number;
	/** state-variable filter cells */
	low: number;
	band: number;
	active: boolean;
	born: number;
}

export const MICROKORG_PROGRAMS: readonly { name: string; patch: MicroKorgPatch }[] = [
	{
		name: 'Analog Bass',
		patch: {
			osc1: 'saw',
			osc2: 'square',
			osc2Octave: -1,
			detune: 0,
			osc2Level: 0.5,
			sync: false,
			ring: false,
			pulseWidth: 0.5,
			filterMode: 'LP',
			cutoff: 900,
			resonance: 0.45,
			keyTrack: 200,
			envToFilter: 2.5,
			filterAttack: 0.005,
			filterDecay: 0.25,
			filterSustain: 0.2,
			filterRelease: 0.1,
			ampAttack: 0.002,
			ampDecay: 0.2,
			ampSustain: 0.7,
			ampRelease: 0.12,
			lfoRate: 5,
			lfoPitch: 0,
			lfoFilter: 0,
			volume: 0.9,
		},
	},
	{
		name: 'VA Saw Lead',
		patch: {
			osc1: 'saw',
			osc2: 'saw',
			osc2Octave: 0,
			detune: 12,
			osc2Level: 0.6,
			sync: false,
			ring: false,
			pulseWidth: 0.5,
			filterMode: 'LP',
			cutoff: 2600,
			resonance: 0.3,
			keyTrack: 300,
			envToFilter: 1.2,
			filterAttack: 0.02,
			filterDecay: 0.4,
			filterSustain: 0.5,
			filterRelease: 0.25,
			ampAttack: 0.005,
			ampDecay: 0.5,
			ampSustain: 0.8,
			ampRelease: 0.3,
			lfoRate: 5.5,
			lfoPitch: 6,
			lfoFilter: 3,
			volume: 0.8,
		},
	},
	{
		name: 'Sync Lead',
		patch: {
			osc1: 'saw',
			osc2: 'square',
			osc2Octave: 1,
			detune: 7,
			osc2Level: 0.7,
			sync: true,
			ring: false,
			pulseWidth: 0.3,
			filterMode: 'LP',
			cutoff: 3200,
			resonance: 0.55,
			keyTrack: 400,
			envToFilter: 2,
			filterAttack: 0.01,
			filterDecay: 0.3,
			filterSustain: 0.4,
			filterRelease: 0.2,
			ampAttack: 0.004,
			ampDecay: 0.35,
			ampSustain: 0.75,
			ampRelease: 0.2,
			lfoRate: 6.5,
			lfoPitch: 0,
			lfoFilter: 5,
			volume: 0.75,
		},
	},
	{
		name: 'Brass Stack',
		patch: {
			osc1: 'saw',
			osc2: 'saw',
			osc2Octave: 0,
			detune: -8,
			osc2Level: 0.8,
			sync: false,
			ring: false,
			pulseWidth: 0.5,
			filterMode: 'LP',
			cutoff: 1800,
			resonance: 0.25,
			keyTrack: 500,
			envToFilter: 1.5,
			filterAttack: 0.06,
			filterDecay: 0.3,
			filterSustain: 0.7,
			filterRelease: 0.15,
			ampAttack: 0.05,
			ampDecay: 0.4,
			ampSustain: 0.9,
			ampRelease: 0.2,
			lfoRate: 5,
			lfoPitch: 4,
			lfoFilter: 0,
			volume: 0.8,
		},
	},
	{
		name: 'Virtual Strings',
		patch: {
			osc1: 'square',
			osc2: 'triangle',
			osc2Octave: 0,
			detune: 5,
			osc2Level: 0.5,
			sync: false,
			ring: false,
			pulseWidth: 0.5,
			filterMode: 'LP',
			cutoff: 2400,
			resonance: 0.15,
			keyTrack: 400,
			envToFilter: 0.8,
			filterAttack: 0.02,
			filterDecay: 1.2,
			filterSustain: 0.3,
			filterRelease: 0.4,
			ampAttack: 0.01,
			ampDecay: 1.5,
			ampSustain: 0.45,
			ampRelease: 0.6,
			lfoRate: 4.5,
			lfoPitch: 3,
			lfoFilter: 2,
			volume: 0.75,
		},
	},
	{
		name: 'Space Pad',
		patch: {
			osc1: 'triangle',
			osc2: 'saw',
			osc2Octave: 0,
			detune: 14,
			osc2Level: 0.4,
			sync: false,
			ring: false,
			pulseWidth: 0.5,
			filterMode: 'LP',
			cutoff: 800,
			resonance: 0.2,
			keyTrack: 200,
			envToFilter: 1,
			filterAttack: 0.8,
			filterDecay: 2,
			filterSustain: 0.6,
			filterRelease: 1.5,
			ampAttack: 0.6,
			ampDecay: 2.5,
			ampSustain: 0.6,
			ampRelease: 1.8,
			lfoRate: 0.6,
			lfoPitch: 8,
			lfoFilter: 6,
			volume: 0.7,
		},
	},
	{
		name: 'Pulse Poly',
		patch: {
			osc1: 'square',
			osc2: 'square',
			osc2Octave: -1,
			detune: 0,
			osc2Level: 0.5,
			sync: false,
			ring: false,
			pulseWidth: 0.25,
			filterMode: 'LP',
			cutoff: 1600,
			resonance: 0.35,
			keyTrack: 300,
			envToFilter: 1.8,
			filterAttack: 0.005,
			filterDecay: 0.2,
			filterSustain: 0.3,
			filterRelease: 0.1,
			ampAttack: 0.004,
			ampDecay: 0.25,
			ampSustain: 0.6,
			ampRelease: 0.15,
			lfoRate: 5,
			lfoPitch: 0,
			lfoFilter: 0,
			volume: 0.8,
		},
	},
	{
		name: 'Filter Sweep',
		patch: {
			osc1: 'saw',
			osc2: 'noise',
			osc2Octave: 0,
			detune: 0,
			osc2Level: 0.2,
			sync: false,
			ring: false,
			pulseWidth: 0.5,
			filterMode: 'BP',
			cutoff: 700,
			resonance: 0.7,
			keyTrack: 0,
			envToFilter: 3,
			filterAttack: 0.9,
			filterDecay: 1.2,
			filterSustain: 0.5,
			filterRelease: 0.5,
			ampAttack: 0.01,
			ampDecay: 1,
			ampSustain: 0.7,
			ampRelease: 0.4,
			lfoRate: 1.5,
			lfoPitch: 0,
			lfoFilter: 8,
			volume: 0.75,
		},
	},
	{
		name: 'Soft Flute',
		patch: {
			osc1: 'triangle',
			osc2: 'off',
			osc2Octave: 0,
			detune: 0,
			osc2Level: 0,
			sync: false,
			ring: false,
			pulseWidth: 0.5,
			filterMode: 'LP',
			cutoff: 1400,
			resonance: 0.1,
			keyTrack: 400,
			envToFilter: 0.4,
			filterAttack: 0.15,
			filterDecay: 0.4,
			filterSustain: 0.6,
			filterRelease: 0.2,
			ampAttack: 0.12,
			ampDecay: 0.6,
			ampSustain: 0.85,
			ampRelease: 0.35,
			lfoRate: 4.8,
			lfoPitch: 12,
			lfoFilter: 0,
			volume: 0.7,
		},
	},
	{
		name: 'Analog EP',
		patch: {
			osc1: 'triangle',
			osc2: 'saw',
			osc2Octave: 1,
			detune: 3,
			osc2Level: 0.25,
			sync: false,
			ring: true,
			pulseWidth: 0.5,
			filterMode: 'LP',
			cutoff: 2000,
			resonance: 0.2,
			keyTrack: 500,
			envToFilter: 1.4,
			filterAttack: 0.003,
			filterDecay: 0.35,
			filterSustain: 0.1,
			filterRelease: 0.2,
			ampAttack: 0.003,
			ampDecay: 0.9,
			ampSustain: 0.35,
			ampRelease: 0.5,
			lfoRate: 4.2,
			lfoPitch: 0,
			lfoFilter: 0,
			volume: 0.75,
		},
	},
];

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** one naive-but-tuned oscillator step, `phase` in cycles */
function wave(kind: MicroKorgWave, phase: number, pulseWidth: number, noiseValue: number): number {
	const x = phase - Math.floor(phase);
	switch (kind) {
		case 'saw':
			return 2 * x - 1;
		case 'square':
			return x < pulseWidth ? 1 : -1;
		case 'triangle':
			return 4 * Math.abs(x - 0.5) - 1;
		default:
			return noiseValue;
	}
}

/** linear segment envelope: rise to 1, fall to sustain, fade on release; returns level and whether it is done */
function envelope(
	t: number,
	released: boolean,
	releaseT: number,
	attack: number,
	decay: number,
	sustain: number,
	release: number,
	releaseFrom: number,
): { level: number; done: boolean } {
	if (released) {
		const r = (t - releaseT) / Math.max(1e-4, release);
		return r >= 1 ? { level: 0, done: true } : { level: releaseFrom * (1 - r), done: false };
	}
	let level: number;
	if (t < attack) level = attack <= 0 ? 1 : t / attack;
	else {
		const d = (t - attack) / Math.max(1e-4, decay);
		level = d >= 1 ? sustain : 1 - (1 - sustain) * d;
	}
	return { level, done: false };
}

export class MicroKorgSynth implements Chip {
	readonly id = 'microkorg';
	readonly name = 'Korg microKORG (virtual analog model)';
	readonly channels = 8;
	readonly clock = 0;
	readonly sampleRate: number;
	private patch: MicroKorgPatch;
	private readonly voices: Voice[] = [];
	private lfoPhase = 0;
	private rng = 0x9e3779b9;
	private clock0 = 0;
	private muted = new Array<boolean>(8).fill(false);

	constructor(options: ChipOptions & { program?: number } = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.patch = structuredClone(
			MICROKORG_PROGRAMS[clamp(options.program ?? 0, 0, MICROKORG_PROGRAMS.length - 1)].patch,
		);
		for (let v = 0; v < this.channels; v++) this.voices.push(this.idle(v));
	}

	private idle(born: number): Voice {
		return {
			note: -1,
			velocity: 0,
			phase1: 0,
			phase2: 0,
			ampT: 0,
			fltT: 0,
			released: true,
			releaseT: 0,
			releaseFromAmp: 0,
			releaseFromFlt: 0,
			low: 0,
			band: 0,
			active: false,
			born,
		};
	}

	private releaseT = 0;

	get activeVoices(): number {
		return this.voices.filter((v) => v.active).length;
	}

	/** the live patch: controls edit its fields and the synth reads them per sample */
	loadProgram(patch: MicroKorgPatch): void {
		this.patch = patch;
	}

	selectProgram(index: number): void {
		this.loadProgram(structuredClone(MICROKORG_PROGRAMS[clamp(index, 0, MICROKORG_PROGRAMS.length - 1)].patch));
	}

	noteOn(note: number, velocity = 100): void {
		const free = this.voices.find((v) => !v.active) ?? this.voices.slice().sort((a, b) => a.born - b.born)[0];
		Object.assign(free, this.idle(free.born), {
			note,
			velocity: clamp(velocity, 1, 127),
			released: false,
			active: true,
			born: ++this.clock0,
		});
	}

	noteOff(note: number): void {
		for (const v of this.voices)
			if (v.active && !v.released && v.note === note) {
				v.released = true;
				this.releaseT = v.ampT;
				v.releaseT = this.releaseT;
				v.releaseFromAmp = envelope(v.ampT, true, v.releaseT, 0, 0, 0, 0, 1).level;
				const f = this.patch;
				v.releaseFromFlt = envelope(v.fltT, true, v.releaseT, f.filterAttack, f.filterDecay, f.filterSustain, 0, 1).level;
			}
	}

	reset(): void {
		for (let v = 0; v < this.channels; v++) this.voices[v] = this.idle(v);
		this.lfoPhase = 0;
		this.clock0 = 0;
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 8) this.muted[channel] = muted;
	}

	read(): number {
		return 0;
	}

	write(addr: number, value: number): void {
		if (addr >= 0 && addr < 128) this.noteOn(addr, value);
		else if (addr === 128) this.selectProgram(value);
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const dt = 1 / this.sampleRate;
		for (let i = 0; i < count; i++) {
			const lfo = Math.sin(2 * Math.PI * this.lfoPhase);
			this.lfoPhase = (this.lfoPhase + this.patch.lfoRate * dt) % 1;
			let sum = 0;
			for (let v = 0; v < this.channels; v++) {
				const voice = this.voices[v];
				if (!voice.active || this.muted[v]) continue;
				sum += this.sampleVoice(voice, dt, lfo);
			}
			const out = sum * 0.25 * this.patch.volume;
			left[start + i] += out;
			right[start + i] += out;
		}
	}

	private sampleVoice(v: Voice, dt: number, lfo: number): number {
		const p = this.patch;
		v.ampT += dt;
		v.fltT += dt;
		const amp = envelope(v.ampT, v.released, v.releaseT, p.ampAttack, p.ampDecay, p.ampSustain, p.ampRelease, v.releaseFromAmp);
		const flt = envelope(
			v.fltT,
			v.released,
			v.releaseT,
			p.filterAttack,
			p.filterDecay,
			p.filterSustain,
			p.filterRelease,
			v.releaseFromFlt,
		);
		if (amp.done && v.released) {
			Object.assign(v, this.idle(v.born));
			return 0;
		}
		const hz =
			440 *
			2 **
				((v.note - 69 + (p.lfoPitch * lfo) / 100 + (p.lfoPitch * 0) / 100) / 12 +
					(p.lfoPitch * lfo) / 1200);
		const hz2 = hz * 2 ** p.osc2Octave * 2 ** (p.detune / 1200);
		const o1 = wave(p.osc1, v.phase1, p.pulseWidth, this.noise());
		const wrapped1 = v.phase1 + hz * dt;
		const syncReset = p.sync && Math.floor(wrapped1) !== Math.floor(v.phase1);
		v.phase1 = wrapped1;
		let o2 = 0;
		if (p.osc2 !== 'off') {
			o2 = wave(p.osc2 as MicroKorgWave, syncReset ? 0 : v.phase2, p.pulseWidth, this.noise());
			if (p.ring) o2 *= o1;
			v.phase2 = (syncReset ? 0 : v.phase2) + hz2 * dt;
		}
		const mix = (o1 + o2 * p.osc2Level) / (p.osc2 === 'off' ? 1 : 2);
		const cutoff = clamp(
			p.cutoff *
				2 **
					((flt.level * p.envToFilter + (p.keyTrack * (v.note - 60)) / 1200 + (p.lfoFilter * lfo) / 12) +
						(p.lfoFilter * lfo) / 12) *
				0 +
				2 ** ((flt.level * p.envToFilter + (p.keyTrack * (v.note - 60)) / 1200 + p.lfoFilter * lfo * 0.01) * 1),
			20,
			this.sampleRate * 0.45,
		);
		const filtered = this.svf(v, mix, cutoff, p.resonance, p.filterMode);
		return filtered * amp.level * (0.25 + (0.75 * v.velocity) / 127);
	}

	/** state-variable filter (Chamberlin), LP/HP/BP taps, resonance as lowered damping */
	private svf(v: Voice, input: number, cutoffHz: number, resonance: number, mode: MicroKorgPatch['filterMode']): number {
		const f = 2 * Math.sin((Math.PI * Math.min(cutoffHz, this.sampleRate * 0.45)) / this.sampleRate);
		const damp = clamp(1.8 - 1.6 * resonance, 0.2, 1.9);
		v.low += f * v.band;
		const high = input - v.low - damp * v.band;
		v.band += f * high;
		return mode === 'LP' ? v.low : mode === 'HP' ? high : v.band;
	}

	/** deterministic white noise (xorshift), shared by the noise oscillators of every voice */
	private noise(): number {
		let x = this.rng >>> 0;
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		this.rng = x >>> 0;
		return ((x >>> 16) / 32768 - 1) as number;
	}
}

import { BaseInstrument } from './BaseInstrument.ts';
import type { Chip } from '../chips/Chip.ts';
import type { InstrumentOptions } from './Instrument.ts';
import { param, rangeControl } from './controls.ts';

/** Additive timbre with an ADSR envelope; coefficients are amplitudes of successive harmonics. */
export interface SimpleProfile {
	name: string;
	harmonics: readonly number[];
	attack: number;
	decay: number;
	sustain: number;
	release: number;
}

export const piano: SimpleProfile = {
	name: 'Piano',
	harmonics: [1, 0.45, 0.2, 0.1, 0.06],
	attack: 0.003,
	decay: 1.5,
	sustain: 0,
	release: 0.2,
};
export const electricPiano: SimpleProfile = {
	name: 'Electric piano',
	harmonics: [1, 0.12, 0.4, 0.04],
	attack: 0.002,
	decay: 2,
	sustain: 0,
	release: 0.3,
};
export const organ: SimpleProfile = {
	name: 'Organ',
	harmonics: [1, 0.5, 0.3, 0.2, 0.1, 0.1, 0.06, 0.08],
	attack: 0.008,
	decay: 0.1,
	sustain: 1,
	release: 0.04,
};
export const guitar: SimpleProfile = {
	name: 'Guitar',
	harmonics: [1, 0.5, 0.3, 0.2, 0.12, 0.06],
	attack: 0.002,
	decay: 1.1,
	sustain: 0,
	release: 0.12,
};
export const bass: SimpleProfile = {
	name: 'Bass',
	harmonics: [1, 0.35, 0.15],
	attack: 0.005,
	decay: 0.6,
	sustain: 0.15,
	release: 0.1,
};
export const strings: SimpleProfile = {
	name: 'Strings',
	harmonics: [1, 0.5, 0.33, 0.25, 0.2, 0.16],
	attack: 0.25,
	decay: 0.3,
	sustain: 0.7,
	release: 0.5,
};
export const brass: SimpleProfile = {
	name: 'Brass',
	harmonics: [1, 0.7, 0.5, 0.3, 0.2],
	attack: 0.05,
	decay: 0.2,
	sustain: 0.75,
	release: 0.15,
};
export const flute: SimpleProfile = {
	name: 'Flute',
	harmonics: [1, 0.05, 0.12, 0.02],
	attack: 0.04,
	decay: 0.2,
	sustain: 0.8,
	release: 0.12,
};
export const synth: SimpleProfile = {
	name: 'Synth',
	harmonics: [1, 0, 0.33, 0, 0.2, 0, 0.14],
	attack: 0.01,
	decay: 0.2,
	sustain: 0.6,
	release: 0.25,
};

interface Voice {
	note: number;
	phase: number;
	age: number;
	velocity: number;
	releaseAge?: number;
	releaseLevel: number;
	remaining?: number;
}

/** Sample-clock scheduling: durations advance only when render() consumes audio. No timers are created. */
export class SimpleInstrument extends BaseInstrument {
	readonly info;
	readonly chip: Chip;
	private voices: Voice[] = [];
	private readonly volume = param(0.5);
	private muted = false;
	private readonly profile: SimpleProfile;

	constructor(
		profile: SimpleProfile = piano,
		options: InstrumentOptions = {},
		readonly polyphony = 16,
	) {
		super(options);
		if (!Number.isFinite(this.sampleRate) || this.sampleRate <= 0 || !Number.isInteger(polyphony) || polyphony < 1)
			throw new RangeError('Invalid sample rate or polyphony');
		if (
			!profile.harmonics.length ||
			profile.harmonics.some((v) => !Number.isFinite(v)) ||
			[profile.attack, profile.decay, profile.release].some((v) => !Number.isFinite(v) || v < 0) ||
			!Number.isFinite(profile.sustain) ||
			profile.sustain < 0 ||
			profile.sustain > 1
		)
			throw new RangeError('Invalid synthesis profile');
		this.profile = { ...profile, harmonics: [...profile.harmonics] };
		this.info = {
			id: `simple:${profile.name}`,
			name: profile.name,
			family: 'synth' as const,
			era: 'Modern',
			description: 'Additive synthesis; evocative timbre, not an acoustic recording or hardware emulation.',
			polyphony,
		};
		this.controls = [rangeControl({ id: 'volume', label: 'Volume', min: 0, max: 1, step: 0.01 }, this.volume)];
		this.chip = {
			id: this.info.id,
			name: profile.name,
			channels: 1,
			clock: this.sampleRate,
			sampleRate: this.sampleRate,
			reset: () => {
				this.voices = [];
				this.muted = false;
			},
			write: () => {},
			read: () => 0,
			setMuted: (_channel, muted) => {
				this.muted = muted;
			},
			render: (left, right, start, count) => this.renderVoices(left, right, start, count),
		};
	}

	protected press(note: number, velocity: number): void {
		if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isFinite(velocity))
			throw new RangeError('Invalid MIDI note or velocity');
		this.voices = this.voices.filter((v) => v.note !== note);
		if (this.voices.length >= this.polyphony) {
			const stolen = this.voices.shift()!;
			this.forgetNote(stolen.note);
		}
		this.voices.push({ note, phase: 0, age: 0, velocity: velocity / 127, releaseLevel: 0 });
	}

	override noteOn(note: number, velocity = 100): void {
		if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isFinite(velocity))
			throw new RangeError('Invalid MIDI note or velocity');
		super.noteOn(note, velocity);
	}

	protected lift(note: number): void {
		for (const voice of this.voices)
			if (voice.note === note && voice.releaseAge === undefined) {
				voice.releaseLevel = this.level(voice);
				voice.releaseAge = 0;
			}
	}

	/** Play a note or chord; optional duration is in seconds, measured in rendered samples. */
	play(notes: number | readonly number[], duration?: number, velocity = 100): void {
		if (duration !== undefined && (!Number.isFinite(duration) || duration < 0))
			throw new RangeError('Invalid duration');
		for (const note of typeof notes === 'number' ? [notes] : notes) {
			this.noteOn(note, velocity);
			const voice = this.voices.find((v) => v.note === note);
			if (voice && duration !== undefined) voice.remaining = Math.round(duration * this.sampleRate);
		}
	}

	private level(v: Voice): number {
		const p = this.profile;
		if (v.releaseAge !== undefined)
			return p.release === 0 ? 0 : v.releaseLevel * Math.max(0, 1 - v.releaseAge / p.release);
		if (v.age < p.attack) return v.age / p.attack;
		if (v.age < p.attack + p.decay) return 1 - ((1 - p.sustain) * (v.age - p.attack)) / p.decay;
		return p.sustain;
	}

	private renderVoices(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const dt = 1 / this.sampleRate;
		const normalization = Math.max(
			1,
			this.profile.harmonics.reduce((sum, h) => sum + Math.abs(h), 0),
		);
		for (let i = start; i < start + count; i++) {
			let sample = 0;
			for (const v of this.voices) {
				if (v.remaining === 0) {
					this.noteOff(v.note);
					v.remaining = undefined;
				}
				if (v.remaining !== undefined) v.remaining--;
				const frequency = this.hz(v.note);
				const level = this.level(v);
				for (let h = 0; h < this.profile.harmonics.length; h++) {
					if (frequency * (h + 1) >= this.sampleRate / 2) break;
					sample +=
						Math.sin(v.phase * (h + 1) * 2 * Math.PI) * this.profile.harmonics[h] * level * v.velocity;
				}
				v.phase = (v.phase + frequency * dt) % 1;
				v.age += dt;
				if (v.releaseAge !== undefined) v.releaseAge += dt;
			}
			if (!this.muted) {
				const output = (sample * this.volume.value) / (normalization * this.polyphony);
				left[i] += output;
				right[i] += output;
			}
			this.voices = this.voices.filter((v) => v.releaseAge === undefined || v.releaseAge < this.profile.release);
		}
	}
}

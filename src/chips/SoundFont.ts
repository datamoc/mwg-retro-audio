import type { Chip, ChipOptions } from './Chip.ts';
import type { SfVoice, SoundFont } from '../formats/soundfont.ts';

/**
 * A sample player for the presets of a SoundFont 2 bank (`formats/soundfont.ts`): a note starts one voice for every
 * zone that matches its key and velocity, each voice plays its sample at the pitch of the key (with linear
 * interpolation), loops it the way the zone says, and shapes it with the volume envelope, the fixed low-pass filter,
 * the attenuation and the pan of the zone. The default velocity-to-attenuation modulator of the specification is
 * applied (the amplitude follows the square of the velocity).
 *
 * Settings that belong to the player and not to the bank: a gain, a pan offset, scales for the attack and release
 * times, and switches for the filter and the loops. See `formats/soundfont.ts` for what of the format is modelled.
 */

const MAX_VOICES = 64;
const DB_PER_RELEASE = 100;

const enum Stage {
	Delay,
	Attack,
	Hold,
	Decay,
	Sustain,
	Release,
}

interface Playing {
	voice: SfVoice;
	key: number;
	/** position in the sample data, in points */
	position: number;
	step: number;
	gain: number;
	left: number;
	right: number;
	stage: Stage;
	/** time spent in the current stage, in seconds */
	stageTime: number;
	/** the envelope in dB of attenuation, once the attack is over (0 = full) */
	attenuationDb: number;
	level: number;
	released: boolean;
	age: number;
	filter: { ic1: number; ic2: number };
	done: boolean;
}

export class SoundFontSynth implements Chip {
	readonly id = 'soundfont';
	readonly channels = 1;
	readonly clock = 0;
	readonly sampleRate: number;
	readonly name: string;
	/** the player's own settings */
	gainDb = 0;
	/** -0.5 (left) to 0.5 (right), added to the pan of every zone */
	panOffset = 0;
	attackScale = 1;
	releaseScale = 1;
	useFilter = true;
	useLoops = true;
	preset = 0;
	private playing: Playing[] = [];
	private age = 0;
	private muted = false;

	constructor(
		readonly font: SoundFont,
		options: ChipOptions & { preset?: number } = {},
	) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.name = `${font.name} (SoundFont)`;
		if (options.preset !== undefined) this.selectPreset(options.preset);
	}

	selectPreset(index: number): void {
		if (index >= 0 && index < this.font.presets.length) this.preset = Math.floor(index);
	}

	get activeVoices(): number {
		return this.playing.length;
	}

	reset(): void {
		this.playing = [];
	}

	write(addr: number, value: number): void {
		if (addr === 128) this.selectPreset(value);
		else if (addr >= 0 && addr < 128) this.noteOn(addr, value);
	}

	read(): number {
		return 0;
	}

	setMuted(_channel: number, muted: boolean): void {
		this.muted = muted;
	}

	noteOn(key: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(key);
		const velocityGain = (Math.min(127, velocity) / 127) ** 2;
		const born = ++this.age;
		for (const voice of this.font.voices(this.preset, key, Math.min(127, velocity))) {
			if (voice.end - voice.start < 2) continue;
			const cents = (key - voice.rootKey) * voice.scaleTuning + voice.tuneCents;
			const pan = Math.min(0.5, Math.max(-0.5, voice.pan + this.panOffset));
			const angle = (pan + 0.5) * (Math.PI / 2);
			this.playing.push({
				voice,
				key,
				position: voice.start,
				step: (2 ** (cents / 1200) * voice.sample.sampleRate) / this.sampleRate,
				gain: velocityGain * 10 ** (-voice.attenuationDb / 20) * 10 ** (this.gainDb / 20) * 0.5,
				left: Math.cos(angle) * Math.SQRT2,
				right: Math.sin(angle) * Math.SQRT2,
				stage: Stage.Delay,
				stageTime: 0,
				attenuationDb: 0,
				level: 0,
				released: false,
				age: born,
				filter: { ic1: 0, ic2: 0 },
				done: false,
			});
		}
		if (this.playing.length > MAX_VOICES) {
			// the oldest notes give way, all the voices of a note together
			const oldest = Math.min(...this.playing.map((entry) => entry.age));
			this.playing = this.playing.filter((entry) => entry.age !== oldest);
		}
	}

	noteOff(key: number): void {
		for (const entry of this.playing) {
			if (entry.key === key && !entry.released) {
				entry.released = true;
				entry.stage = Stage.Release;
				entry.stageTime = 0;
			}
		}
	}

	/** advance the envelope by one sample and return its amplitude */
	private envelope(entry: Playing, dt: number): number {
		const v = entry.voice;
		entry.stageTime += dt;
		switch (entry.stage) {
			case Stage.Delay:
				if (entry.stageTime >= v.delay) this.enter(entry, Stage.Attack);
				return 0;
			case Stage.Attack: {
				const time = v.attack * this.attackScale;
				entry.level = time <= dt ? 1 : Math.min(1, entry.stageTime / time);
				if (entry.level >= 1) this.enter(entry, Stage.Hold);
				return entry.level;
			}
			case Stage.Hold:
				if (entry.stageTime >= v.hold) this.enter(entry, Stage.Decay);
				entry.level = 1;
				return 1;
			case Stage.Decay: {
				const sustainDb = -20 * Math.log10(Math.max(1e-6, v.sustain));
				entry.attenuationDb += (dt * DB_PER_RELEASE) / Math.max(1e-3, v.decay);
				if (entry.attenuationDb >= sustainDb) {
					entry.attenuationDb = sustainDb;
					this.enter(entry, Stage.Sustain);
				}
				entry.level = 10 ** (-entry.attenuationDb / 20);
				return entry.level;
			}
			case Stage.Sustain:
				entry.level = 10 ** (-entry.attenuationDb / 20);
				return entry.level;
			default: {
				if (entry.stageTime === dt) entry.attenuationDb = entry.level > 0 ? -20 * Math.log10(entry.level) : 0;
				entry.attenuationDb += (dt * DB_PER_RELEASE) / Math.max(1e-3, v.release * this.releaseScale);
				if (entry.attenuationDb >= 96) {
					entry.done = true;
					return 0;
				}
				entry.level = 10 ** (-entry.attenuationDb / 20);
				return entry.level;
			}
		}
	}

	private enter(entry: Playing, stage: Stage): void {
		entry.stage = stage;
		entry.stageTime = 0;
		if (stage === Stage.Hold) entry.attenuationDb = 0;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		if (this.muted || this.playing.length === 0) {
			if (this.muted) this.playing = [];
			return;
		}
		const data = this.font.data;
		const dt = 1 / this.sampleRate;
		for (let i = 0; i < count; i++) {
			let l = 0;
			let r = 0;
			for (const entry of this.playing) {
				if (entry.done) continue;
				const v = entry.voice;
				const looping =
					this.useLoops && (v.loopMode === 'loop' || (v.loopMode === 'release' && !entry.released));
				if (looping) {
					const length = v.loopEnd - v.loopStart;
					while (entry.position >= v.loopEnd) entry.position -= length;
				} else if (entry.position >= v.end - 1) {
					entry.done = true;
					continue;
				}
				const index = Math.floor(entry.position);
				const fraction = entry.position - index;
				const next = looping && index + 1 >= v.loopEnd ? v.loopStart : Math.min(index + 1, v.end - 1);
				let x = data[index] + (data[next] - data[index]) * fraction;
				entry.position += entry.step;
				if (this.useFilter && v.cutoffHz < 19000) x = this.lowPass(entry, x, v);
				x *= this.envelope(entry, dt) * entry.gain;
				l += x * entry.left;
				r += x * entry.right;
			}
			left[start + i] += l;
			right[start + i] += r;
		}
		this.playing = this.playing.filter((entry) => !entry.done);
	}

	/** the fixed low-pass of the zone: a state variable filter, stable at any cut-off */
	private lowPass(entry: Playing, x: number, v: SfVoice): number {
		const damping = Math.SQRT2 * 10 ** (-v.resonanceDb / 20);
		const g = Math.tan((Math.PI * Math.min(v.cutoffHz, this.sampleRate * 0.45)) / this.sampleRate);
		const a1 = 1 / (1 + g * (g + damping));
		const a2 = g * a1;
		const a3 = g * a2;
		const f = entry.filter;
		const v3 = x - f.ic2;
		const v1 = a1 * f.ic1 + a2 * v3;
		const v2 = f.ic2 + a2 * f.ic1 + a3 * v3;
		f.ic1 = 2 * v1 - f.ic1;
		f.ic2 = 2 * v2 - f.ic2;
		return v2;
	}
}

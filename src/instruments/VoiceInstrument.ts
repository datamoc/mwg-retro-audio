import { BaseInstrument } from './BaseInstrument.ts';
import type { RangeControl } from './Instrument.ts';
import { param, rangeControl } from './controls.ts';
import type { VoiceAllocator } from './VoiceAllocator.ts';

/** samples between two updates of the software envelope and the vibrato (about 2 ms): the rate of a tracker "tick" */
const TICK = 96;

const enum Stage {
	Idle,
	Attack,
	Decay,
	Sustain,
	Release,
}

/**
 * An instrument for a chip with fixed voices (channels): the subclass starts, stops and retunes one channel; this class
 * allocates notes to channels and adds what the chips of the period did in software, a volume envelope (attack, decay,
 * sustain, release) and a vibrato, both updated a few hundred times a second through the chip's own registers.
 *
 * A chip that has a hardware envelope of its own (SID, FM) sets `softEnvelope = false`: the note then starts and stops
 * the voice and the chip does the rest.
 */
export abstract class VoiceInstrument extends BaseInstrument {
	protected abstract readonly allocator: VoiceAllocator;
	/** drive the volume register from the software envelope (default true) */
	protected softEnvelope = true;
	/** software envelope settings: attack, decay and release in milliseconds, sustain as a level 0..1 */
	protected readonly amp = { attack: param(2), decay: param(250), sustain: param(1), release: param(60) };
	/** vibrato settings: depth in cents, rate in Hz, delay in milliseconds before it starts */
	protected readonly vibrato = { depth: param(0), rate: param(5.5), delay: param(250) };

	private stage: Stage[] = [];
	private level: number[] = [];
	private gain: number[] = [];
	private releaseFrom: number[] = [];
	private age: number[] = [];
	private lfoPhase = 0;
	private vibTime = 0;

	/** start (or restart) a channel on a frequency; `stolen` is true when it was playing another note */
	protected abstract startVoice(channel: number, hz: number, velocity: number, stolen: boolean): void;
	/** the voice is over (its release finished, or the note was lifted on a chip with a hardware envelope): silence it */
	protected abstract stopVoice(channel: number): void;
	/** change the pitch of a sounding channel (pitch bend, vibrato) */
	protected abstract setVoicePitch(channel: number, hz: number): void;
	/** the software envelope's level for a channel, 0..1 (velocity included): write it to the volume register */
	protected setVoiceLevel(_channel: number, _level: number): void {}

	private ensure(): void {
		if (this.stage.length === this.allocator.voices) return;
		const n = this.allocator.voices;
		this.stage = new Array(n).fill(Stage.Idle);
		this.level = new Array(n).fill(0);
		this.gain = new Array(n).fill(1);
		this.releaseFrom = new Array(n).fill(0);
		this.age = new Array(n).fill(0);
	}

	/** velocity 1..127 to an amplitude gain: a soft curve so that soft notes stay audible */
	protected velocityGain(velocity: number): number {
		return 0.25 + 0.75 * (velocity / 127) ** 1.5;
	}

	protected press(note: number, velocity: number): void {
		this.ensure();
		const { voice, stolen, stolenNote } = this.allocator.take(note);
		if (stolenNote !== undefined) this.forgetNote(stolenNote);
		this.gain[voice] = this.velocityGain(velocity);
		this.age[voice] = 0;
		if (this.softEnvelope) {
			this.stage[voice] = Stage.Attack;
			if (stolen) this.level[voice] = 0;
		}
		this.startVoice(voice, this.hz(note), velocity, stolen);
		if (this.softEnvelope) this.setVoiceLevel(voice, this.level[voice] * this.gain[voice]);
	}

	protected lift(note: number): void {
		this.ensure();
		const voice = this.allocator.release(note);
		if (voice < 0) return;
		if (!this.softEnvelope || this.amp.release.value <= 0) {
			this.stage[voice] = Stage.Idle;
			this.level[voice] = 0;
			this.stopVoice(voice);
			return;
		}
		this.releaseFrom[voice] = Math.max(this.level[voice], 1e-3);
		this.stage[voice] = Stage.Release;
	}

	protected override retune(): void {
		for (const { voice, note } of this.allocator.active()) this.setVoicePitch(voice, this.hz(note));
	}

	/** advance the software envelope and the vibrato by `dt` seconds */
	private tick(dt: number): void {
		this.ensure();
		const v = this.vibrato;
		let lfo = 0;
		if (this.allocator.active().length === 0) this.vibTime = 0;
		else {
			this.vibTime += dt;
			if (v.depth.value > 0) {
				this.lfoPhase = (this.lfoPhase + v.rate.value * dt) % 1;
				const fade = v.delay.value <= 0 ? 1 : Math.min(1, this.vibTime / (v.delay.value / 1000));
				lfo = v.depth.value * fade * Math.sin(2 * Math.PI * this.lfoPhase);
			}
		}
		if (lfo !== this.lfoCents) {
			this.lfoCents = lfo;
			this.retune();
		}
		if (!this.softEnvelope) return;
		const a = this.amp;
		for (let ch = 0; ch < this.stage.length; ch++) {
			const s = this.stage[ch];
			if (s === Stage.Idle) continue;
			this.age[ch] += dt;
			let level = this.level[ch];
			if (s === Stage.Attack) {
				level = a.attack.value <= 0 ? 1 : level + dt / (a.attack.value / 1000);
				if (level >= 1) {
					level = 1;
					this.stage[ch] = Stage.Decay;
				}
			} else if (s === Stage.Decay) {
				const sus = a.sustain.value;
				level = a.decay.value <= 0 ? sus : level - ((1 - sus) * dt) / (a.decay.value / 1000);
				if (level <= sus) {
					level = sus;
					this.stage[ch] = Stage.Sustain;
				}
			} else if (s === Stage.Release) {
				level -= (this.releaseFrom[ch] * dt) / Math.max(1e-4, a.release.value / 1000);
				if (level <= 0) {
					this.level[ch] = 0;
					this.stage[ch] = Stage.Idle;
					this.stopVoice(ch);
					continue;
				}
			}
			this.level[ch] = level;
			this.setVoiceLevel(ch, level * this.gain[ch]);
		}
	}

	override render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const dt = TICK / this.sampleRate;
		for (let done = 0; done < count;) {
			const n = Math.min(TICK, count - done);
			this.tick((dt * n) / TICK);
			this.chip.render(left, right, start + done, n);
			done += n;
		}
	}

	override reset(): void {
		this.allocator.clear();
		this.stage = [];
		this.lfoPhase = 0;
		this.vibTime = 0;
		super.reset();
	}

	/** the four envelope controls, to include in an instrument that uses the software envelope */
	protected ampControls(group = 'Amplitude'): RangeControl[] {
		const a = this.amp;
		return [
			rangeControl(
				{
					id: 'amp-attack',
					label: 'Attack',
					group,
					unit: 'ms',
					min: 0,
					max: 2000,
					step: 1,
					scale: 'log',
					hint: 'Time to reach full volume',
				},
				a.attack,
			),
			rangeControl(
				{
					id: 'amp-decay',
					label: 'Decay',
					group,
					unit: 'ms',
					min: 0,
					max: 4000,
					step: 1,
					scale: 'log',
					hint: 'Time to fall to the sustain level',
				},
				a.decay,
			),
			rangeControl(
				{
					id: 'amp-sustain',
					label: 'Sustain',
					group,
					min: 0,
					max: 1,
					step: 0.01,
					hint: 'Level held while the key is down',
				},
				a.sustain,
			),
			rangeControl(
				{
					id: 'amp-release',
					label: 'Release',
					group,
					unit: 'ms',
					min: 0,
					max: 4000,
					step: 1,
					scale: 'log',
					hint: 'Fade out after the key is released',
				},
				a.release,
			),
		];
	}

	/** the vibrato controls (depth, rate, delay) */
	protected vibratoControls(group = 'Vibrato'): RangeControl[] {
		const v = this.vibrato;
		return [
			rangeControl(
				{
					id: 'vib-depth',
					label: 'Depth',
					group,
					unit: 'cents',
					min: 0,
					max: 200,
					step: 1,
					hint: 'Pitch swing of the vibrato',
				},
				v.depth,
			),
			rangeControl(
				{
					id: 'vib-rate',
					label: 'Rate',
					group,
					unit: 'Hz',
					min: 0.5,
					max: 14,
					step: 0.1,
					hint: 'Speed of the vibrato',
				},
				v.rate,
			),
			rangeControl(
				{
					id: 'vib-delay',
					label: 'Delay',
					group,
					unit: 'ms',
					min: 0,
					max: 2000,
					step: 10,
					hint: 'Time before the vibrato fades in',
				},
				v.delay,
			),
		];
	}
}

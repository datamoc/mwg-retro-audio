import { Region } from '../region.ts';
import type { PSGVoice } from './PSGVoice.ts';

export { Region };

export interface TrackerStep {
	/** MIDI note number, or null for a rest */
	note: number | null;
	/** 0 to 15 */
	volume: number;
	/** semitone offsets cycled once per tick (automatic arpeggio) */
	arpeggio?: number[];
}

/**
 * Layer 1 - a small step sequencer for a single PSG voice. Its clock follows the standard of the original
 * material: one step per frame, 50 times a second for PAL and 60 for NTSC.
 *
 * @example
 * ```ts
 * const player = new TrackerPlayer(voice, Region.NTSC);
 * player.loadSteps([{ note: 60, volume: 15, arpeggio: [0, 4, 7] }], Region.NTSC);
 * player.start();
 * ```
 */
export class TrackerPlayer {
	private voice: PSGVoice;
	private timerId: ReturnType<typeof setInterval> | null = null;
	private region: Region;
	private steps: TrackerStep[] = [];
	private currentStep: number = 0;
	private arpIndex: number = 0;

	constructor(voice: PSGVoice, region: Region = Region.PAL) {
		this.voice = voice;
		this.region = region;
	}

	public loadSteps(steps: TrackerStep[], region: Region): void {
		this.steps = steps;
		this.region = region;
		this.currentStep = 0;
		this.arpIndex = 0;
	}

	public start(): void {
		if (this.timerId) return;
		const intervalMs = 1000 / this.region; // strictly PAL (50 Hz) or NTSC (60 Hz)

		this.timerId = setInterval(() => {
			this.tick();
		}, intervalMs);
	}

	public stop(): void {
		if (this.timerId) {
			clearInterval(this.timerId);
			this.timerId = null;
		}
		this.voice.stop();
	}

	private tick(): void {
		if (this.steps.length === 0) return;

		const step = this.steps[this.currentStep];
		if (step && step.note !== null) {
			let activeNote = step.note;

			if (step.arpeggio && step.arpeggio.length > 0) {
				activeNote += step.arpeggio[this.arpIndex];
				this.arpIndex = (this.arpIndex + 1) % step.arpeggio.length;
			}

			const freq = 440 * Math.pow(2, (activeNote - 69) / 12);
			this.voice.setFrequency(freq);
			this.voice.setVolume(step.volume / 15);
		} else {
			this.voice.setVolume(0);
		}

		this.currentStep = (this.currentStep + 1) % this.steps.length;
	}
}

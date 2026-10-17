import type { Chip } from '../chips/Chip.ts';
import { Region } from '../region.ts';

export interface PlayerInfo {
	/** file format that produced the player ('ym', 'vgm', 'nsf', 'sid', 'mod', ...) */
	format: string;
	title?: string;
	author?: string;
	comment?: string;
	/** chip ids driven by the file */
	chips: string[];
	/** standard of the original material: decides frame rate and chip clocks */
	region: Region;
	/** frames (ticks) per second of the original player */
	frameRate: number;
	/** total length in seconds when known, loop excluded */
	durationSeconds?: number;
	/** loop point in seconds from the start, when the file has one */
	loopStartSeconds?: number;
}

/**
 * Layer 1 - anything that turns a music file into register writes in time and reads the audio back from the chips.
 */
export interface RetroPlayer {
	readonly info: PlayerInfo;
	readonly sampleRate: number;
	readonly chips: readonly Chip[];
	/** true once the end was reached (never true for a looping player) */
	readonly finished: boolean;
	/** restart from the beginning */
	reset(): void;
	/**
	 * ADD up to `count` stereo frames into the buffers from `start`. Returns how many frames were produced;
	 * a value below `count` means the music ended (the remainder is left untouched).
	 */
	render(left: Float32Array, right: Float32Array, start: number, count: number): number;
	/** mute one channel of one chip */
	setMuted(chipIndex: number, channel: number, muted: boolean): void;
}

interface Scheduled {
	at: number;
	fn: () => void;
}

/**
 * Base class for players that work frame by frame: `beginFrame()` runs once per frame interrupt of the original
 * machine, writes the registers (immediately, or at a given sample offset inside the frame with `at()` for
 * cycle-accurate sources) and the chips render the audio in between.
 */
export abstract class FramePlayer implements RetroPlayer {
	abstract readonly info: PlayerInfo;
	abstract readonly chips: readonly Chip[];
	protected ended = false;
	private frameRemainder = 0;
	private frameLength = 0;
	private frameOffset = 0;
	private queue: Scheduled[] = [];
	/** frames elapsed since the start (including the one in progress) */
	protected frameCount = 0;

	constructor(readonly sampleRate: number) {}

	get finished(): boolean {
		return this.ended && this.frameOffset >= this.frameLength;
	}

	/** current frame rate in Hz: may change during playback (VGM speed changes, tracker tempo) */
	protected abstract currentFrameRate(): number;
	/** advance the music by one frame; return false when there is no more music */
	protected abstract beginFrame(): boolean;
	/** rewind the music data */
	protected abstract restart(): void;

	reset(): void {
		this.ended = false;
		this.frameRemainder = 0;
		this.frameLength = 0;
		this.frameOffset = 0;
		this.queue = [];
		this.frameCount = 0;
		for (const c of this.chips) c.reset();
		this.restart();
	}

	/** run `fn` when the render position reaches `sampleOffset` frames after the start of the current frame */
	protected at(sampleOffset: number, fn: () => void): void {
		const item = { at: Math.max(0, Math.floor(sampleOffset)), fn };
		// stable insertion keeps writes of equal time in order
		let i = this.queue.length;
		while (i > 0 && this.queue[i - 1].at > item.at) i--;
		this.queue.splice(i, 0, item);
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): number {
		let done = 0;
		while (done < count) {
			if (this.frameOffset >= this.frameLength) {
				if (this.ended) break;
				this.runDue(Infinity); // writes scheduled past the end of the previous frame still happen, in order
				this.queue = [];
				this.frameCount++;
				if (!this.beginFrame()) {
					this.ended = true;
					break;
				}
				const exact = this.sampleRate / this.currentFrameRate() + this.frameRemainder;
				this.frameLength = Math.max(1, Math.floor(exact));
				this.frameRemainder = exact - this.frameLength;
				this.frameOffset = 0;
			}
			this.runDue(this.frameOffset);
			const nextAt = this.queue.length ? Math.min(this.queue[0].at, this.frameLength) : this.frameLength;
			const n = Math.min(count - done, Math.max(0, nextAt - this.frameOffset));
			if (n > 0) {
				for (const c of this.chips) c.render(left, right, start + done, n);
				this.frameOffset += n;
				done += n;
			}
		}
		return done;
	}

	private runDue(offset: number): void {
		while (this.queue.length && this.queue[0].at <= offset) this.queue.shift()!.fn();
	}

	setMuted(chipIndex: number, channel: number, muted: boolean): void {
		this.chips[chipIndex]?.setMuted(channel, muted);
	}
}

import type { Playable } from '@datamoc/mwg/audio';
import { RetroStream, type RetroStreamOptions } from '../driver/RetroStream.ts';
import { skipFrames } from '../driver/Renderer.ts';
import { loadFile, type LoadFileOptions } from '../formats/load.ts';
import type { RetroPlayer } from '../players/Player.ts';

export interface RetroPlayableOptions {
	context: AudioContext;
	/** node the music is connected to (default: the context destination) */
	destination?: AudioNode;
	stream?: RetroStreamOptions;
}

/**
 * Makes any `RetroPlayer` usable wherever mwg expects a `Playable`: `new Music({ create })` crossfades it, the
 * `volume` goes through a gain node, `loop` repeats the tune, `currentTime` reads and seeks the position and
 * `onended` fires when the tune ends. The player's sample rate must be the context's.
 */
export class RetroPlayable implements Playable {
	private readonly gain: GainNode;
	private stream: RetroStream | null = null;
	private startedAtContext = 0;
	private offset = 0;
	private vol = 1;
	private looping = false;
	private playing = false;
	onended: ((event: Event) => unknown) | null = null;

	constructor(
		private readonly player: RetroPlayer | Promise<RetroPlayer>,
		private readonly options: RetroPlayableOptions,
	) {
		this.gain = options.context.createGain();
		this.gain.connect(options.destination ?? options.context.destination);
	}

	get volume(): number {
		return this.vol;
	}
	set volume(v: number) {
		this.vol = Math.max(0, Math.min(1, v));
		this.gain.gain.setValueAtTime(this.vol, this.options.context.currentTime);
	}

	get loop(): boolean {
		return this.looping;
	}
	set loop(v: boolean) {
		this.looping = v;
		// a running stream picks the flag up at its next chunk
		if (this.stream) this.stream.loop = v;
	}

	get currentTime(): number {
		if (!this.playing) return this.offset;
		return this.offset + (this.options.context.currentTime - this.startedAtContext);
	}
	set currentTime(seconds: number) {
		const was = this.playing;
		if (was) this.pause();
		this.offset = Math.max(0, seconds);
		if (was) void this.play();
	}

	async play(): Promise<void> {
		if (this.playing) return;
		const ctx = this.options.context;
		if (ctx.state === 'suspended') await ctx.resume();
		const player = await this.player;
		player.reset();
		if (this.offset > 0) skipFrames(player, Math.floor(this.offset * player.sampleRate));
		this.stream = new RetroStream(ctx, this.gain, player, { ...this.options.stream, loop: this.looping });
		this.stream.onended = () => {
			this.playing = false;
			this.offset = 0;
			this.onended?.(new Event('ended'));
		};
		this.gain.gain.setValueAtTime(this.vol, ctx.currentTime);
		this.startedAtContext = ctx.currentTime + 0.05;
		this.playing = true;
		this.stream.start();
	}

	pause(): void {
		if (!this.playing) return;
		this.offset = this.currentTime;
		this.playing = false;
		this.stream?.stop();
		this.stream = null;
	}
}

/**
 * A `create` function for `new Music({ create })`: it resolves a path to bytes (`fetchBytes`, default `fetch`),
 * detects the format and gives back a `Playable` that starts as soon as the file is loaded.
 *
 * @example
 * ```ts
 * const music = new Music({ create: retroPlayableFactory({ context }) });
 * music.play('music/title.mwa', 1);
 * ```
 */
export function retroPlayableFactory(
	options: RetroPlayableOptions & {
		fetchBytes?: (path: string) => Promise<Uint8Array>;
		/** load options (song number of an NSF / SID, region, Amiga clock...) */
		load?: Omit<LoadFileOptions, 'sampleRate' | 'name' | 'loop'>;
	},
): (path: string) => Playable {
	const fetchBytes =
		options.fetchBytes ??
		(async (path: string) => {
			const response = await fetch(path);
			if (!response.ok) throw new Error(`cannot load ${path}: ${response.status}`);
			return new Uint8Array(await response.arrayBuffer());
		});
	return (path: string) => {
		const player = fetchBytes(path).then((bytes) =>
			loadFile(bytes, { ...options.load, name: path, sampleRate: options.context.sampleRate }),
		);
		return new RetroPlayable(player, options);
	};
}

import type { BusKind, BusLoadContext, BusLoader, LoadedTrack, StreamLoader } from '@datamoc/mwg/audio';
import { renderPlayer, toAudioBuffer, type BufferFactory } from '../driver/Renderer.ts';
import type { OutputStageOptions } from '../driver/OutputStage.ts';
import { loadFile, type LoadFileOptions } from '../formats/load.ts';
import type { RetroPlayer } from '../players/Player.ts';
import { retroBlockSource, retroLoopRegion } from './blockSource.ts';

export interface RenderTrackOptions {
	/** longest tune to render, seconds (default 300: endless NSF / SID tunes are cut there) */
	maxSeconds?: number;
	output?: OutputStageOptions;
	/** fade-out at the end of an endless tune cut at `maxSeconds` (default 2 s) */
	fadeOut?: number;
}

/**
 * Render a retro tune once to an `AudioBuffer`, with its loop region taken from the file, ready for mwg's `Channel`
 * and `AudioBus` (`LoadedTrack`). The loop covers the file's loop point to the end; tunes without a loop point loop
 * as a whole when `loopWhole` is set.
 */
export function renderTrack(
	player: RetroPlayer,
	ctx: BufferFactory,
	options: RenderTrackOptions & { loopWhole?: boolean } = {},
): LoadedTrack {
	const result = renderPlayer(player, {
		maxSeconds: options.maxSeconds ?? 300,
		output: options.output,
		fadeOut: options.fadeOut ?? 2,
	});
	const buffer = toAudioBuffer(ctx, result);
	const start = player.info.loopStartSeconds;
	if (start !== undefined) return { buffer, loop: { start, end: result.duration } };
	return { buffer, loop: options.loopWhole ? { start: 0, end: result.duration } : null };
}

export interface RetroStreamLoaderOptions {
	context: { sampleRate: number };
	/** path of a bus asset (default: `${kind}/${name}`); return null for an asset this loader does not provide */
	locate?: (kind: BusKind, name: string) => string | null;
	fetchBytes?: (path: string, signal?: AbortSignal) => Promise<Uint8Array>;
	load?: Omit<LoadFileOptions, 'sampleRate' | 'name' | 'loop'>;
}

export interface RetroBusLoaderOptions extends RetroStreamLoaderOptions, RenderTrackOptions {
	context: BufferFactory & { sampleRate: number };
	/** kinds whose tunes loop as a whole when the file has no loop point (default: bgm and bgs) */
	loopKinds?: readonly BusKind[];
}

function createPlayerLoader(
	options: RetroStreamLoaderOptions,
): (kind: BusKind, name: string, context?: BusLoadContext) => Promise<RetroPlayer | null> {
	const fetchBytes =
		options.fetchBytes ??
		(async (path: string, signal?: AbortSignal) => {
			const response = await fetch(path, { signal });
			if (!response.ok) throw new Error(`cannot load ${path}: ${response.status}`);
			return new Uint8Array(await response.arrayBuffer());
		});
	return async (kind: BusKind, name: string, context?: BusLoadContext): Promise<RetroPlayer | null> => {
		if (context?.signal.aborted) return null;
		const path = options.locate ? options.locate(kind, name) : `${kind}/${name}`;
		if (!path) return null;
		context?.progress(0);
		try {
			const bytes = await fetchBytes(path, context?.signal);
			if (context?.signal.aborted) return null;
			context?.progress(0.5);
			return loadFile(bytes, {
				...options.load,
				name: path,
				sampleRate: options.context.sampleRate,
				loop: false,
			});
		} catch {
			return null;
		}
	};
}

/**
 * A buffered loader for `AudioBus`, with file loop points and optional load progress/cancellation.
 * Unknown paths return null. Prefer `retroStreamLoader` for long BGM and BGS tracks.
 */
export function retroBusLoader(options: RetroBusLoaderOptions): BusLoader {
	const loadPlayer = createPlayerLoader(options);
	const loopKinds = options.loopKinds ?? ['bgm', 'bgs'];
	return async (kind, name, context) => {
		const player = await loadPlayer(kind, name, context);
		if (!player || context?.signal.aborted) return null;
		const track = renderTrack(player, options.context, { ...options, loopWhole: loopKinds.includes(kind) });
		context?.progress(1);
		return track;
	};
}

/**
 * Stream BGM and BGS through `AudioBus` without rendering the whole tune into memory.
 * Each request owns a fresh player; mwg controls looping, seeking and the channel lifetime.
 * Unknown files return null so the bus can try its buffered loader.
 * Rendering and seeks still run on the calling thread; use hosted MIDI for expensive synths.
 */
export function retroStreamLoader(options: RetroStreamLoaderOptions): StreamLoader {
	const loadPlayer = createPlayerLoader(options);
	return async (kind, name, context) => {
		const player = await loadPlayer(kind, name, context);
		if (!player || context.signal.aborted) return null;
		context.progress(1);
		return { source: retroBlockSource(player), loop: retroLoopRegion(player) };
	};
}

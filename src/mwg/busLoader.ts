import type { BusKind, BusLoader, LoadedTrack } from '@datamoc/mwg/audio';
import { renderPlayer, toAudioBuffer, type BufferFactory } from '../driver/Renderer.ts';
import type { OutputStageOptions } from '../driver/OutputStage.ts';
import { loadFile, type LoadFileOptions } from '../formats/load.ts';
import type { RetroPlayer } from '../players/Player.ts';

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

export interface RetroBusLoaderOptions extends RenderTrackOptions {
	context: BufferFactory & { sampleRate: number };
	/** path of a bus asset (default: `${kind}/${name}`); return null for an asset this loader does not provide */
	locate?: (kind: BusKind, name: string) => string | null;
	fetchBytes?: (path: string) => Promise<Uint8Array>;
	load?: Omit<LoadFileOptions, 'sampleRate' | 'name' | 'loop'>;
	/** kinds whose tunes loop as a whole when the file has no loop point (default: bgm and bgs) */
	loopKinds?: readonly BusKind[];
}

/**
 * A `BusLoader` for mwg's `AudioBus`: background music, ambience, jingles and sound effects stored as YM, VGM, NSF,
 * SID, MOD, XM, IT, CMF, DRO, IMF, WAV, VOC or MWA files are rendered through the engine and handed over as buffers.
 * Unknown paths give `null`, as the bus expects.
 */
export function retroBusLoader(options: RetroBusLoaderOptions): BusLoader {
	const fetchBytes =
		options.fetchBytes ??
		(async (path: string) => {
			const response = await fetch(path);
			if (!response.ok) throw new Error(`cannot load ${path}: ${response.status}`);
			return new Uint8Array(await response.arrayBuffer());
		});
	const loopKinds = options.loopKinds ?? ['bgm', 'bgs'];
	return async (kind, name) => {
		const path = options.locate ? options.locate(kind, name) : `${kind}/${name}`;
		if (!path) return null;
		let bytes: Uint8Array;
		try {
			bytes = await fetchBytes(path);
		} catch {
			return null;
		}
		let player: RetroPlayer;
		try {
			player = loadFile(bytes, { ...options.load, name: path, sampleRate: options.context.sampleRate });
		} catch {
			return null;
		}
		return renderTrack(player, options.context, { ...options, loopWhole: loopKinds.includes(kind) });
	};
}

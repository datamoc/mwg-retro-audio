import type { BlockSource, LoopRegion } from '@datamoc/mw_games/audio';
import { skipFrames } from '../driver/Renderer.ts';
import type { RetroPlayer } from '../players/Player.ts';

export interface RetroBlockSourceOptions {
	/**
	 * Report no end even when the file states a duration: `StreamChannel` then loops through
	 * `repeat` and `loop` instead of treating one pass as the whole source. Endless formats
	 * (looping NSF, SID, trackers) are endless already; this is for a player loaded with
	 * `loop: true`, whose length is one pass of the tune.
	 */
	endless?: boolean;
}

/**
 * A `RetroPlayer` behind mwg's `BlockSource` contract, for `StreamChannel` and
 * `StreamPlayable`: frames are synthesised as they are pulled, so an endless or very long
 * tune costs a couple of seconds of memory instead of a whole render. `seek` answers by
 * restarting the tune and running it to that frame (the engine is deterministic, so the
 * audio at a position is the same whether it was reached or seeked to; seeking far costs
 * the time it takes to emulate the skipped part).
 *
 * Load the player with `loop: false` and let the stream loop it with `repeat` and
 * `retroLoopRegion`, so the loop point comes from the file and the playhead stays honest.
 *
 * @example
 * ```ts
 * import { StreamPlayable } from '@datamoc/mw_games/audio';
 * import { retroBlockSource, retroLoopRegion } from '@datamoc/mwg-retro-audio/mwg';
 *
 * const player = loadFile(bytes, { sampleRate: context.sampleRate, name: 'title.nsf' });
 * const stream = new StreamPlayable(context, retroBlockSource(player), {
 * 	loopRegion: retroLoopRegion(player),
 * });
 * stream.loop = true;
 * void stream.play();
 * ```
 */
export function retroBlockSource(player: RetroPlayer, options: RetroBlockSourceOptions = {}): BlockSource {
	const seconds = player.info.durationSeconds;
	const length =
		options.endless || seconds === undefined ? undefined : Math.max(1, Math.round(seconds * player.sampleRate));
	return {
		sampleRate: player.sampleRate,
		length,
		read(left, right, start, count) {
			return player.render(left, right, start, count);
		},
		seek(frame) {
			player.reset();
			if (frame > 0) skipFrames(player, Math.floor(frame));
		},
	};
}

/**
 * The repeat region `StreamPlayable`/`StreamChannel` ask for: from the file's loop point to
 * the stated end, or null when the file gives no loop point (the whole source is repeated
 * then, which is what the stream does with `loop` unset).
 */
export function retroLoopRegion(player: RetroPlayer): LoopRegion | null {
	const start = player.info.loopStartSeconds;
	const end = player.info.durationSeconds;
	if (start === undefined || end === undefined || end <= start) return null;
	return { start, end };
}

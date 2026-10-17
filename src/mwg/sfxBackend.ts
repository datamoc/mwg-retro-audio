import type { SfxBackend, SfxDefinition as MwgSfxDefinition, SfxVoice as MwgSfxVoice } from '@datamoc/mw_games/audio';
import type { SfxEngine } from '../sfx/engine.ts';
import type { SfxDefinition } from '../sfx/types.ts';

/**
 * Our effect definitions ride through mwg's `SfxBank` untouched (the contract says backend
 * data passes along as-is); this says how to board them: `id` gets the definition's `name`,
 * and `'layer'` in mwg speaks `'stack'` here.
 */
export function toMwgSfxDefinition(definition: SfxDefinition): MwgSfxDefinition {
	const { retrigger, ...rest } = definition;
	return {
		...rest,
		name: definition.name,
		id: definition.name,
		retrigger: retrigger === 'stack' ? 'layer' : retrigger,
	};
}

/** the definition on the bus is mwg's; the engine reads the retro fields that rode through */
function retroName(definition: MwgSfxDefinition): string {
	return typeof definition.name === 'string' && definition.name ? definition.name : definition.id;
}

export interface RetroSfxBackendOptions {
	/** engine with the banks already loaded (`loadBank`, `define`) and the music chips attached */
	engine: SfxEngine;
	/** level below which a trigger is dropped; 0 when omitted */
	minGain?: number;
}

/**
 * A `SfxBackend` voicing mwg's data sound effects with the retro `SfxEngine`, on the same
 * chips as the music: the mix mwg computed (gain, pan, pitch ratio) maps to the engine's
 * volume, pan and semitone offset, and mwg's arbiter stays the judge of how many effects
 * sound at once. An effect the engine does not own, or one with no free channel, gives
 * null as the contract asks, which is not an error. The engine is deterministic (fixed
 * curves, chip LFSRs), so mwg's `seed` needs no randomness here and A/V stays on the game's
 * frame counter.
 *
 * @example
 * ```ts
 * import { SfxBank } from '@datamoc/mw_games/audio';
 * import { retroSfxBackend, toMwgSfxDefinition } from '@datamoc/mwg-retro-audio/mwg';
 *
 * const bank = new SfxBank([toMwgSfxDefinition(laser)]);
 * const backend = retroSfxBackend({ engine });
 * ```
 */
export function retroSfxBackend(options: RetroSfxBackendOptions): SfxBackend {
	const engine = options.engine;
	const minGain = options.minGain ?? 0;
	return {
		play(definition, play) {
			if (play.gain <= minGain) return null;
			let id: number | null;
			try {
				id = engine.play(retroName(definition), {
					volume: play.gain,
					pan: play.pan,
					pitchOffset: play.pitch === 1 ? 0 : 12 * Math.log2(play.pitch),
				});
			} catch {
				return null; // the engine does not voice this id
			}
			if (id === null) return null;
			const voice: MwgSfxVoice = {
				stop: () => engine.stop(id!),
				get active(): boolean {
					return engine.isActive(id!);
				},
			};
			return voice;
		},
	};
}

import type { BusLoader, Channel, LoadedTrack } from '@datamoc/mwg/audio';
import { createRetroEffectChain, type RetroEffectChain } from '../effects/chain.ts';
import { processRetroEffects } from '../effects/pcm.ts';
import { retroEffects, type RetroEffectName, type RetroEffectPreset } from '../effects/presets.ts';

/**
 * A channel that can take a whole effect chain. A host that implements this contract routes its
 * output through `chain.input` and `chain.output` to its destination; `removeEffect` detaches it.
 */
export interface RetroEffectHost {
	insertEffect?(chain: RetroEffectChain): void;
	removeEffect?(chain: RetroEffectChain): void;
}

/**
 * The parts of mwg's `Channel` this adapter uses. mwg 0.53 exposes `insert` / `removeInsert`
 * (used directly); older versions keep `context` and `destination` private, so they are read
 * here at runtime as a fallback.
 */
export interface RetroEffectsTarget extends RetroEffectHost {
	context?: BaseAudioContext;
	destination?: AudioNode;
	insert?(node: AudioNode): void;
	removeInsert?(node: AudioNode): void;
}

export interface RetroEffectsForOptions {
	/** context used to build the chain; inferred from the channel when omitted */
	context?: BaseAudioContext;
}

export interface RetroEffectsHandle {
	readonly preset: RetroEffectPreset;
	readonly chain: RetroEffectChain;
	/** change the preset in place, without rebuilding the routing */
	setPreset(preset: RetroEffectName | RetroEffectPreset): void;
	/** detach the chain and restore the channel's destination */
	dispose(): void;
}

class Attachment implements RetroEffectsHandle {
	private readonly target: RetroEffectsTarget;
	private readonly originalDestination: AudioNode | undefined;
	private readonly mode: 'insert' | 'host' | 'destination';
	private disposed = false;

	constructor(target: RetroEffectsTarget, chain: RetroEffectChain) {
		this.target = target;
		this.chain = chain;
		if (typeof target.insert === 'function' && typeof target.removeInsert === 'function') {
			this.mode = 'insert';
			this.originalDestination = undefined;
			try {
				for (const node of chain.nodes) target.insert(node);
			} catch (error) {
				for (const node of chain.nodes) target.removeInsert?.(node);
				chain.dispose();
				throw error;
			}
			return;
		}
		if (typeof target.insertEffect === 'function') {
			this.mode = 'host';
			this.originalDestination = undefined;
			try {
				target.insertEffect(chain);
			} catch (error) {
				chain.dispose();
				throw error;
			}
			return;
		}
		const destination = target.destination;
		if (!destination) {
			chain.dispose();
			throw new Error(
				'retroEffectsFor: this channel exposes neither insert(), insertEffect() nor a destination AudioNode; pass a real mwg Channel or options.context with a custom host',
			);
		}
		this.mode = 'destination';
		this.originalDestination = destination;
		chain.output.connect(destination);
		try {
			target.destination = chain.input;
		} catch (error) {
			chain.output.disconnect();
			chain.dispose();
			throw new Error(
				'retroEffectsFor: the channel destination is read-only; implement insertEffect() on the host',
				{
					cause: error,
				},
			);
		}
	}

	readonly chain: RetroEffectChain;

	get preset(): RetroEffectPreset {
		return this.chain.preset;
	}

	setPreset(preset: RetroEffectName | RetroEffectPreset): void {
		if (this.disposed) throw new Error('retro effect attachment is disposed');
		this.chain.setPreset(preset);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.mode === 'insert') {
			for (const node of this.chain.nodes) this.target.removeInsert?.(node);
		} else if (this.mode === 'host') {
			this.target.removeEffect?.(this.chain);
		} else if (this.originalDestination && this.target.destination === this.chain.input) {
			this.target.destination = this.originalDestination;
		}
		this.chain.dispose();
	}
}

/**
 * Attach a retro effect preset to an mwg `Channel`. The chain sits after the channel's own gain
 * and panner and before its destination, so every voice the channel starts — including restarts
 * after a seek — goes through it.
 *
 * mwg 0.53's `Channel.insert` / `removeInsert` are used natively: the chain's nodes are inserted
 * in signal order and removed again on `dispose`, without restarting a playing voice. A channel
 * that exposes only `insertEffect(chain)` receives the whole chain, and an older channel with a
 * writable `destination` gets the destination rerouted through the chain.
 *
 * @example
 * ```ts
 * import { Channel } from '@datamoc/mwg/audio';
 * import { retroEffectsFor } from '@datamoc/mwg-retro-audio/mwg';
 *
 * const channel = new Channel(context);
 * const effects = retroEffectsFor(channel, 'sid');
 * channel.play(buffer);
 * // later
 * effects.setPreset('nes');
 * effects.dispose();
 * ```
 */
export function retroEffectsFor(
	channel: Channel,
	preset: RetroEffectName | RetroEffectPreset,
	options?: RetroEffectsForOptions,
): RetroEffectsHandle;
export function retroEffectsFor(
	channel: RetroEffectsTarget,
	preset: RetroEffectName | RetroEffectPreset,
	options?: RetroEffectsForOptions,
): RetroEffectsHandle;
export function retroEffectsFor(
	channel: object,
	preset: RetroEffectName | RetroEffectPreset,
	options: RetroEffectsForOptions = {},
): RetroEffectsHandle {
	const target = channel as RetroEffectsTarget;
	const context = options.context ?? target.context ?? target.destination?.context;
	if (!context) {
		throw new Error('retroEffectsFor: cannot find an AudioContext; pass options.context');
	}
	// resolve the preset before building nodes, so an unknown name fails before anything is wired
	retroEffects(preset);
	const nativeInsert = typeof target.insert === 'function' && typeof target.removeInsert === 'function';
	return new Attachment(target, createRetroEffectChain(context, preset, { connect: !nativeInsert }));
}

/** process every channel pair of a decoded buffer in place; mono is processed once and copied back */
function processTrack(track: LoadedTrack, preset: RetroEffectPreset): LoadedTrack {
	const buffer = track.buffer;
	for (let channel = 0; channel < buffer.numberOfChannels; channel += 2) {
		const left = buffer.getChannelData(channel);
		const right =
			channel + 1 < buffer.numberOfChannels ? buffer.getChannelData(channel + 1) : new Float32Array(left);
		processRetroEffects(left, right, buffer.sampleRate, preset);
	}
	return track;
}

/**
 * Wrap an mwg `BusLoader` so every decoded track is processed with a retro preset before it
 * plays. This is the plain-SE path: `AudioBus` loads a normal sample, and the preset is applied
 * to its samples exactly once, with the same code as the offline renderer. A buffer returned by
 * a caching base loader is remembered, so repeated plays do not stack the effect.
 *
 * The wrapper covers buffered tracks (`AudioBus.load`), which is what SE and short jingles use.
 * A streaming BGM/BGS loader (`AudioBus.stream`) has no whole buffer to process; leave it
 * unwrapped or apply the chain to a `Channel` instead.
 *
 * @example
 * ```ts
 * import { AudioBus } from '@datamoc/mwg/audio';
 * import { retroEffectsLoader } from '@datamoc/mwg-retro-audio/mwg';
 *
 * const bus = new AudioBus(context, { load: retroEffectsLoader(load, 'sid') });
 * await bus.playSe({ name: 'door.wav' });
 * ```
 */
export function retroEffectsLoader(base: BusLoader, preset: RetroEffectName | RetroEffectPreset): BusLoader {
	const resolved = retroEffects(preset);
	// mwg's own loader may cache decoded buffers by path; process each cached buffer only once
	const processed = new WeakSet<AudioBuffer>();
	return async (kind, name, context) => {
		const track = await base(kind, name, context);
		if (!track) return null;
		if (!processed.has(track.buffer)) {
			processed.add(track.buffer);
			processTrack(track, resolved);
		}
		return track;
	};
}

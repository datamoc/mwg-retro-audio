import type { RetroPlayer } from '../players/Player.ts';
import { OutputStage, type OutputStageOptions } from './OutputStage.ts';

export interface RenderResult {
	sampleRate: number;
	left: Float32Array;
	right: Float32Array;
	/** seconds, the frames actually produced */
	duration: number;
	/** true when the music ended before `maxSeconds` */
	ended: boolean;
}

export interface RenderOptions {
	/** stop after this many seconds (default 600) */
	maxSeconds?: number;
	/** output stage applied to the whole render */
	output?: OutputStageOptions;
	/** fade-out length in seconds applied to the end when the render was cut at maxSeconds (default 0) */
	fadeOut?: number;
}

/**
 * Render a player offline to stereo float buffers, running the output stage over the result.
 * The player is rendered from its current position.
 */
export function renderPlayer(player: RetroPlayer, options: RenderOptions = {}): RenderResult {
	const rate = player.sampleRate;
	const maxFrames = Math.floor((options.maxSeconds ?? 600) * rate);
	const chunk = 4096;
	const chunksL: Float32Array[] = [];
	const chunksR: Float32Array[] = [];
	let total = 0;
	let ended = false;
	const stage = options.output ? new OutputStage(rate, options.output) : null;
	while (total < maxFrames) {
		const n = Math.min(chunk, maxFrames - total);
		const l = new Float32Array(n);
		const r = new Float32Array(n);
		const got = player.render(l, r, 0, n);
		if (stage) stage.process(l, r, 0, got);
		chunksL.push(l.subarray(0, got));
		chunksR.push(r.subarray(0, got));
		total += got;
		if (got < n) {
			ended = true;
			break;
		}
	}
	const left = new Float32Array(total);
	const right = new Float32Array(total);
	let o = 0;
	for (let i = 0; i < chunksL.length; i++) {
		left.set(chunksL[i], o);
		right.set(chunksR[i], o);
		o += chunksL[i].length;
	}
	const fade = Math.floor((options.fadeOut ?? 0) * rate);
	if (!ended && fade > 0) {
		for (let i = 0; i < Math.min(fade, total); i++) {
			const g = i / fade;
			left[total - 1 - i] *= 1 - g;
			right[total - 1 - i] *= 1 - g;
		}
	}
	return { sampleRate: rate, left, right, duration: total / rate, ended };
}

/** Advance a player by `frames` frames without keeping the audio (seeking: the chips must see every write) */
export function skipFrames(player: RetroPlayer, frames: number): void {
	const chunk = 8192;
	const l = new Float32Array(chunk);
	const r = new Float32Array(chunk);
	for (let done = 0; done < frames;) {
		const n = Math.min(chunk, frames - done);
		l.fill(0);
		r.fill(0);
		if (player.render(l, r, 0, n) < n) return;
		done += n;
	}
}

/** Encode stereo float buffers as a 16-bit PCM WAV file */
export function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
	const frames = left.length;
	const bytes = new Uint8Array(44 + frames * 4);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + frames * 4, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 2, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 4, true);
	view.setUint16(32, 4, true);
	view.setUint16(34, 16, true);
	ascii(36, 'data');
	view.setUint32(40, frames * 4, true);
	const clip = (x: number): number => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
	for (let i = 0; i < frames; i++) {
		view.setInt16(44 + i * 4, clip(left[i]), true);
		view.setInt16(46 + i * 4, clip(right[i]), true);
	}
	return bytes;
}

/** Minimal surface of an AudioContext needed to turn rendered audio into an AudioBuffer */
export interface BufferFactory {
	createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
}

/** Copy rendered audio into a Web Audio AudioBuffer (what mwg's Channel and AudioBus play) */
export function toAudioBuffer(ctx: BufferFactory, result: RenderResult): AudioBuffer {
	const buffer = ctx.createBuffer(2, Math.max(1, result.left.length), result.sampleRate);
	buffer.copyToChannel(result.left as Float32Array<ArrayBuffer>, 0);
	buffer.copyToChannel(result.right as Float32Array<ArrayBuffer>, 1);
	return buffer;
}

/**
 * Opus export: resample to 48 kHz, encode with a packet encoder, wrap in Ogg (`ogg.ts`).
 *
 * There is no Opus encoder in this package (it would be a large piece of code, and the browsers already ship a
 * good one): the default encoder is **WebCodecs `AudioEncoder`**, available in current Chrome, Edge, Safari and
 * Firefox. Where it is missing (Node, old browsers) `encodeOpus` rejects with an explicit error, and the caller can
 * supply its own `OpusPacketEncoder` (a WebAssembly build of libopus, a native binding, a command line tool).
 */
import { muxOggOpus } from './ogg.ts';
import { resampleStereo } from './resample.ts';

/** what an Opus packet encoder returns: packets of `samplesPerPacket` samples at 48 kHz each */
export interface OpusPackets {
	packets: Uint8Array[];
	samplesPerPacket: number | number[];
	/** samples the decoder must drop at the start (the encoder's look-ahead; 312 for libopus at 48 kHz) */
	preSkip: number;
}

/** encodes 48 kHz stereo audio to Opus packets; `progress` is called with the fraction done (0..1) */
export type OpusPacketEncoder = (
	left: Float32Array,
	right: Float32Array,
	progress?: (fraction: number) => void,
) => Promise<OpusPackets>;

export interface OpusOptions {
	/** bits per second (default 128 000 for stereo) */
	bitrate?: number;
	/** frame length in milliseconds: 2.5, 5, 10, 20 (default), 40 or 60 */
	frameMs?: number;
	application?: 'audio' | 'voip' | 'lowdelay';
	/** Vorbis comments (TITLE, ARTIST...) */
	tags?: Record<string, string>;
	/** an encoder to use instead of WebCodecs */
	encoder?: OpusPacketEncoder;
	/** called with the fraction of the encoding done (0..1) */
	onProgress?: (fraction: number) => void;
	signal?: AbortSignal;
}

const OPUS_RATE = 48000;
const DEFAULT_PRE_SKIP = 312;
/** zeros appended after the audio so the encoder's look-ahead is flushed: the decoder then returns every real sample */
const TAIL_PAD = 480;

// The parts of WebCodecs used here, declared locally so the package does not depend on the DOM lib version.
interface EncodedChunk {
	byteLength: number;
	duration: number | null;
	copyTo(destination: Uint8Array): void;
}
interface ChunkMetadata {
	decoderConfig?: { description?: ArrayBuffer | ArrayBufferView };
}
interface WebCodecsEncoder {
	encodeQueueSize: number;
	configure(config: object): void;
	encode(data: unknown): void;
	flush(): Promise<void>;
	close(): void;
}
interface WebCodecsGlobals {
	AudioEncoder?: {
		new (init: {
			output: (chunk: EncodedChunk, metadata?: ChunkMetadata) => void;
			error: (e: Error) => void;
		}): WebCodecsEncoder;
		isConfigSupported(config: object): Promise<{ supported?: boolean }>;
	};
	AudioData?: new (init: object) => { close(): void };
}

const webCodecs = (): WebCodecsGlobals => globalThis as unknown as WebCodecsGlobals;

function encoderConfig(options: OpusOptions): object {
	return {
		codec: 'opus',
		sampleRate: OPUS_RATE,
		numberOfChannels: 2,
		bitrate: options.bitrate ?? 128_000,
		opus: {
			frameDuration: Math.round((options.frameMs ?? 20) * 1000),
			application: options.application ?? 'audio',
		},
	};
}

/** true when this environment can encode Opus through WebCodecs */
export async function isOpusEncodingAvailable(options: OpusOptions = {}): Promise<boolean> {
	const g = webCodecs();
	if (!g.AudioEncoder || !g.AudioData) return false;
	try {
		return Boolean((await g.AudioEncoder.isConfigSupported(encoderConfig(options))).supported);
	} catch {
		return false;
	}
}

const abortError = (): Error => Object.assign(new Error('Opus export aborted'), { name: 'AbortError' });

/** The default packet encoder: WebCodecs `AudioEncoder` */
export function webCodecsOpusEncoder(options: OpusOptions = {}): OpusPacketEncoder {
	return async (left, right, progress) => {
		const g = webCodecs();
		if (!g.AudioEncoder || !g.AudioData)
			throw new Error(
				'Opus export needs WebCodecs (AudioEncoder), which this environment does not have: pass an `encoder` ' +
					'option, or export to FLAC or WAV',
			);
		const config = encoderConfig(options);
		if (!(await g.AudioEncoder.isConfigSupported(config)).supported)
			throw new Error('this browser cannot encode Opus with WebCodecs at the requested settings');
		const frame = Math.round(((options.frameMs ?? 20) * OPUS_RATE) / 1000);
		const packets: Uint8Array[] = [];
		const sizes: number[] = [];
		let preSkip = DEFAULT_PRE_SKIP;
		let failure: Error | null = null;
		const encoder = new g.AudioEncoder({
			output: (chunk, metadata) => {
				const bytes = new Uint8Array(chunk.byteLength);
				chunk.copyTo(bytes);
				packets.push(bytes);
				sizes.push(chunk.duration ? Math.round((chunk.duration * OPUS_RATE) / 1_000_000) : frame);
				const d = metadata?.decoderConfig?.description;
				if (d && packets.length === 1) {
					const head =
						d instanceof ArrayBuffer
							? new Uint8Array(d)
							: new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
					if (head.length >= 12 && String.fromCharCode(...head.subarray(0, 8)) === 'OpusHead')
						preSkip = head[10] | (head[11] << 8);
				}
			},
			error: (e) => {
				failure = e;
			},
		});
		encoder.configure(config);
		try {
			const total = left.length;
			const block = OPUS_RATE; // one second per AudioData
			for (let at = 0; at < total + TAIL_PAD && !failure; at += block) {
				if (options.signal?.aborted) throw abortError();
				const n = Math.min(block, Math.max(0, total - at));
				const last = at + block >= total + TAIL_PAD;
				// whole frames; the last block carries the zero tail that flushes the look-ahead (the Ogg granule trims it)
				const padded = Math.ceil((n + (last ? TAIL_PAD : 0)) / frame) * frame;
				const planar = new Float32Array(padded * 2);
				if (n > 0) {
					planar.set(left.subarray(at, at + n), 0);
					planar.set(right.subarray(at, at + n), padded);
				}
				const data = new g.AudioData({
					format: 'f32-planar',
					sampleRate: OPUS_RATE,
					numberOfFrames: padded,
					numberOfChannels: 2,
					timestamp: Math.round((at * 1_000_000) / OPUS_RATE),
					data: planar,
				});
				encoder.encode(data);
				data.close();
				progress?.(Math.min(1, (at + n) / Math.max(1, total)));
				while (encoder.encodeQueueSize > 16 && !failure) await new Promise((r) => setTimeout(r, 0));
			}
			await encoder.flush();
		} finally {
			encoder.close();
		}
		if (failure) throw failure;
		return { packets, samplesPerPacket: sizes, preSkip };
	};
}

/** Encode stereo float audio as an Ogg Opus file (`.opus`) */
export async function encodeOpus(
	left: Float32Array,
	right: Float32Array,
	sampleRate: number,
	options: OpusOptions = {},
): Promise<Uint8Array> {
	if (left.length !== right.length) throw new RangeError('left and right must have the same length');
	const [l, r] = resampleStereo(left, right, sampleRate, OPUS_RATE);
	const encode = options.encoder ?? webCodecsOpusEncoder(options);
	const { packets, samplesPerPacket, preSkip } = await encode(l, r, options.onProgress);
	return muxOggOpus(packets, {
		channels: 2,
		inputSampleRate: sampleRate,
		preSkip,
		totalSamples: l.length,
		samplesPerPacket,
		tags: options.tags,
	});
}

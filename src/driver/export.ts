import { encodeWav } from './Renderer.ts';
import { encodeFlac, type FlacOptions } from './flac.ts';
import { encodeOpus, type OpusOptions } from './opus.ts';

export type AudioFormat = 'wav' | 'flac' | 'opus';

/** the file extension and MIME type of each export format */
export const AUDIO_FORMATS: Readonly<Record<AudioFormat, { extension: string; mimeType: string }>> = {
	wav: { extension: 'wav', mimeType: 'audio/wav' },
	flac: { extension: 'flac', mimeType: 'audio/flac' },
	opus: { extension: 'opus', mimeType: 'audio/ogg; codecs=opus' },
};

/** stereo float audio to export: a `RenderResult` from `renderPlayer` fits */
export interface AudioSource {
	sampleRate: number;
	left: Float32Array;
	right: Float32Array;
}

export interface ExportOptions {
	/** FLAC only: 16 (default) or 24 bits per sample */
	bitsPerSample?: 16 | 24;
	/** FLAC and Opus: TITLE, ARTIST, COMMENT... (WAV carries no tags) */
	tags?: Record<string, string>;
	/** Opus only: bitrate, encoder, progress, abort signal */
	opus?: Omit<OpusOptions, 'tags'>;
	/** FLAC only: samples per block */
	flacBlockSize?: FlacOptions['blockSize'];
}

/**
 * Export rendered audio as WAV (16 bit PCM), FLAC (lossless, 16 or 24 bit) or Opus (lossy, Ogg container).
 * The result is the bytes of the file. WAV and FLAC are produced by this package in any environment; Opus needs
 * WebCodecs or a caller supplied encoder (see `opus.ts`) and is the only asynchronous one.
 */
export async function exportAudio(
	source: AudioSource,
	format: AudioFormat,
	options: ExportOptions = {},
): Promise<Uint8Array> {
	switch (format) {
		case 'wav':
			return encodeWav(source.left, source.right, source.sampleRate);
		case 'flac':
			return encodeFlac(source.left, source.right, source.sampleRate, {
				bitsPerSample: options.bitsPerSample,
				blockSize: options.flacBlockSize,
				tags: options.tags,
			});
		case 'opus':
			return encodeOpus(source.left, source.right, source.sampleRate, { ...options.opus, tags: options.tags });
		default:
			throw new RangeError(`unknown audio export format: ${String(format)}`);
	}
}

/** `exportAudio` wrapped in a `Blob` with the right MIME type, ready for a download link or `File System Access` */
export async function exportAudioBlob(
	source: AudioSource,
	format: AudioFormat,
	options: ExportOptions = {},
): Promise<Blob> {
	const bytes = await exportAudio(source, format, options);
	return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: AUDIO_FORMATS[format].mimeType });
}

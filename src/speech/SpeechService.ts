import type { BufferFactory } from '../driver/Renderer.ts';
import type { SpeechLanguage } from './g2p.ts';
import { synthesizeSpeech, type SpeechRequest, type SpeechResult } from './speechRender.ts';
import type { SpeakOptions } from './TextToSpeech.ts';

/** The part of a Web Worker the service uses (so that a test, or another host, can supply its own) */
export interface SpeechWorkerLike {
	postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
	addEventListener(type: 'message' | 'error', listener: (event: { data?: unknown }) => void): void;
	removeEventListener(type: 'message' | 'error', listener: (event: { data?: unknown }) => void): void;
	terminate(): void;
}

export interface SpeechServiceOptions {
	/**
	 * Where the synthesis runs: a worker, a function that makes one, `false` to synthesize in the calling thread, or
	 * nothing for the default: the module worker `speech.worker.js` that sits next to this file when the host has
	 * `Worker`, the calling thread otherwise (Node, tests)
	 */
	worker?: SpeechWorkerLike | (() => SpeechWorkerLike) | false;
	/** number of lines kept in the cache (default 64, 0 for none) */
	cacheSize?: number;
}

export interface SpeakLineOptions extends SpeakOptions {
	language?: SpeechLanguage;
	/** peak level of the result, 0..1 (default 0.8) */
	level?: number;
}

interface Pending {
	resolve: (result: SpeechResult) => void;
	reject: (error: Error) => void;
}

/** The default worker: written as one expression so that bundlers (Vite, webpack, esbuild) find and package the file */
function defaultWorker(): SpeechWorkerLike {
	return new Worker(new URL('./speech.worker.js', import.meta.url), {
		type: 'module',
	}) as unknown as SpeechWorkerLike;
}

/**
 * Speech for game dialogue: lines are synthesized off the main thread, so the game keeps its frame rate, and the
 * samples come back as a transferred `Float32Array`, ready for `toAudioBuffer`, with no decoding step. Lines that were
 * already synthesized are kept in a small cache, so a repeated non-player character line costs nothing.
 */
export class SpeechService {
	private worker: SpeechWorkerLike | undefined;
	private readonly pending = new Map<number, Pending>();
	private readonly cache = new Map<string, Promise<SpeechResult>>();
	private readonly cacheSize: number;
	private nextId = 1;

	constructor(options: SpeechServiceOptions = {}) {
		this.cacheSize = options.cacheSize ?? 64;
		const setting = options.worker;
		try {
			if (typeof setting === 'function') this.worker = setting();
			else if (setting) this.worker = setting;
			else if (setting === undefined && typeof Worker !== 'undefined') this.worker = defaultWorker();
		} catch {
			this.worker = undefined; // no worker available here: synthesize in the calling thread
		}
		this.worker?.addEventListener('message', this.onMessage);
		this.worker?.addEventListener('error', this.onError);
	}

	/** true when the synthesis runs in a worker */
	get usesWorker(): boolean {
		return this.worker !== undefined;
	}

	/** Synthesize a line; the promise rejects if the synthesis fails or the service is disposed meanwhile */
	speak(text: string, options: SpeakLineOptions = {}): Promise<SpeechResult> {
		const { language, level, ...speakOptions } = options;
		const request: SpeechRequest = { text, language, options: speakOptions, level };
		const key = JSON.stringify(request);
		const cached = this.cache.get(key);
		if (cached) return cached;
		const result = this.worker ? this.inWorker(this.worker, request) : this.inline(request);
		if (this.cacheSize > 0) {
			this.cache.set(key, result);
			if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string);
			// a failed line must not stay in the cache
			result.catch(() => this.cache.delete(key));
		}
		return result;
	}

	/** Make a mono Web Audio buffer from a result (no `decodeAudioData`: the samples are already PCM) */
	toAudioBuffer(context: BufferFactory, result: SpeechResult): AudioBuffer {
		const buffer = context.createBuffer(1, Math.max(1, result.samples.length), result.sampleRate);
		buffer.copyToChannel(result.samples as Float32Array<ArrayBuffer>, 0);
		return buffer;
	}

	/** Stop the worker and reject the lines still waiting */
	dispose(): void {
		this.worker?.removeEventListener('message', this.onMessage);
		this.worker?.removeEventListener('error', this.onError);
		this.worker?.terminate();
		this.worker = undefined;
		this.cache.clear();
		this.failAll(new Error('SpeechService disposed'));
	}

	private inWorker(worker: SpeechWorkerLike, request: SpeechRequest): Promise<SpeechResult> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ id, request });
		});
	}

	/** without a worker: give the frame back first, then synthesize */
	private inline(request: SpeechRequest): Promise<SpeechResult> {
		return new Promise((resolve, reject) => {
			setTimeout(() => {
				try {
					resolve(synthesizeSpeech(request));
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			}, 0);
		});
	}

	private readonly onMessage = (event: { data?: unknown }): void => {
		const data = event.data as
			{ id: number; success: boolean; samples?: Float32Array; sampleRate?: number; error?: string } | undefined;
		const waiting = data && this.pending.get(data.id);
		if (!data || !waiting) return;
		this.pending.delete(data.id);
		if (data.success && data.samples && data.sampleRate)
			waiting.resolve({ samples: data.samples, sampleRate: data.sampleRate });
		else waiting.reject(new Error(data.error ?? 'speech synthesis failed'));
	};

	private readonly onError = (): void => this.failAll(new Error('speech worker failed'));

	private failAll(error: Error): void {
		for (const waiting of this.pending.values()) waiting.reject(error);
		this.pending.clear();
	}
}

import type { SpeechResult } from './speechRender.ts';
import { loadFrenchVoice, renderFrench, splitSpeechText } from './kokoroFrench.ts';

export interface KokoroVoice {
	id: string;
	name: string;
	language: string;
	gender: string;
}

/** The adapter needs only these operations; hosts can also supply a separately managed runtime. */
export interface KokoroEngine {
	readonly voices: Readonly<Record<string, Omit<KokoroVoice, 'id'>>>;
	stream(
		text: string,
		options: { voice: string; speed: number },
	): AsyncIterable<{
		audio: { audio: Float32Array; sampling_rate: number };
	}>;
	model: { dispose(): Promise<unknown> };
}

export interface KokoroSpeechOptions {
	/** q8 is about 92 MB, excluding runtime files (default). */
	dtype?: 'q8' | 'fp32' | 'fp16';
	/** Default wasm in browsers, cpu in Node. Use fp32 with WebGPU. */
	device?: 'wasm' | 'webgpu' | 'cpu';
	/** Completed lines cached in memory (default 32, 0 disables). */
	cacheSize?: number;
	/** Download events from Transformers.js, suitable for a loading indicator. */
	onProgress?: (event: unknown) => void;
	/** Raw French IPA with stress and ^ ties, e.g. createFrenchPhonemizer() from /node/french-phonemizer. */
	frenchPhonemize?: (text: string) => Promise<string>;
	/** Optional preloaded ff_siwis float32 voice data for offline/self-hosted use. Otherwise fetched on first French line. */
	frenchVoiceData?: Float32Array;
	/** Custom loader; the service takes ownership and disposes the returned model. */
	load?: () => Promise<KokoroEngine>;
}

export interface KokoroSpeakOptions {
	/** French requires frenchPhonemize; defaults to en-US unless a voice is specified. */
	language?: 'en-US' | 'en-GB' | 'fr-FR';
	/** Voice id returned by voices(), e.g. af_heart, am_michael, bf_emma, bm_george. */
	voice?: string;
	/** Speaking speed, 0.5..2, default 1. */
	rate?: number;
}

/** Optional local neural speech. Import from /speech/kokoro; install kokoro-js separately. */
export class KokoroSpeech {
	private loading?: Promise<KokoroEngine>;
	private readonly cache = new Map<string, Promise<SpeechResult>>();
	private readonly cacheSize: number;
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(private readonly options: KokoroSpeechOptions = {}) {
		this.cacheSize = options.cacheSize ?? 32;
		if (!Number.isInteger(this.cacheSize) || this.cacheSize < 0)
			throw new RangeError('cacheSize must be a nonnegative integer');
	}

	/** Download and load once; failed downloads can be retried. Persistent model caching is managed by Transformers.js. */
	async ready(): Promise<void> {
		await this.engine();
	}

	async voices(): Promise<KokoroVoice[]> {
		const engine = await this.engine();
		return Object.entries(engine.voices).map(([id, voice]) => ({ id, ...voice }));
	}

	/** Returns mono 24 kHz PCM. Long lines are streamed in sentence chunks instead of silently truncated. */
	speak(text: string, options: KokoroSpeakOptions = {}): Promise<SpeechResult> {
		if (this.disposed) return Promise.reject(new Error('KokoroSpeech disposed'));
		let voiceLanguage: KokoroSpeakOptions['language'] = 'en-US';
		if (options.voice?.startsWith('b')) voiceLanguage = 'en-GB';
		if (options.voice?.startsWith('f')) voiceLanguage = 'fr-FR';
		const language = options.language ?? voiceLanguage;
		if (!['en-US', 'en-GB', 'fr-FR'].includes(language))
			return Promise.reject(new RangeError(`Unsupported speech language: ${language}`));
		if (language === 'fr-FR' && !this.options.frenchPhonemize && !this.options.load)
			return Promise.reject(
				new Error('French speech requires frenchPhonemize; use createFrenchPhonemizer() in Node'),
			);
		const rate = options.rate ?? 1;
		if (!Number.isFinite(rate) || rate < 0.5 || rate > 2)
			return Promise.reject(new RangeError('Speaking rate must be 0.5..2'));
		if (!text.trim()) return Promise.resolve({ samples: new Float32Array(0), sampleRate: 24000 });
		const defaults = { 'en-US': 'af_heart', 'en-GB': 'bf_emma', 'fr-FR': 'ff_siwis' };
		const voice = options.voice ?? defaults[language];
		const key = JSON.stringify([text, voice, rate, language]);
		const cached = this.cache.get(key);
		if (cached) return cached.then(copyResult);
		// One inference at a time per service; a failed line must not poison subsequent lines.
		const result = this.queue.then(() => this.render(text, voice, rate, language));
		this.queue = result.catch(() => undefined);
		if (this.cacheSize > 0) {
			this.cache.set(key, result);
			if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string);
			void result.catch(() => {
				if (this.cache.get(key) === result) this.cache.delete(key);
			});
		}
		return result.then(copyResult);
	}

	/** Let active inference finish, reject queued work, then release the model. Inference cannot be interrupted. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.cache.clear();
		await this.queue;
		const engine = await this.loading?.catch(() => undefined);
		await engine?.model.dispose();
	}

	private engine(): Promise<KokoroEngine> {
		if (this.disposed) return Promise.reject(new Error('KokoroSpeech disposed'));
		if (!this.loading) {
			const load = this.options.load ?? (() => this.loadDefault());
			this.loading = Promise.resolve()
				.then(load)
				.catch((error: unknown) => {
					this.loading = undefined;
					throw error;
				});
		}
		return this.loading;
	}

	private async loadDefault(): Promise<KokoroEngine> {
		const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
		const node = typeof process !== 'undefined' && Boolean(process.versions?.node);
		const device = this.options.device ?? (node ? 'cpu' : 'wasm');
		const runtime = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
			dtype: this.options.dtype ?? (device === 'webgpu' ? 'fp32' : 'q8'),
			device,
			progress_callback: this.options.onProgress,
		});
		const frenchPhonemize = this.options.frenchPhonemize;
		let frenchVoice: Promise<Float32Array> | undefined;
		const preloadedVoice = this.options.frenchVoiceData?.slice();
		return {
			voices: {
				...runtime.voices,
				...(frenchPhonemize
					? {
							ff_siwis: { name: 'Siwis', language: 'fr-fr', gender: 'Female' },
						}
					: {}),
			},
			model: runtime.model,
			stream(text, options) {
				if (options.voice === 'ff_siwis' && frenchPhonemize) {
					return (async function* () {
						frenchVoice ??= (preloadedVoice ? Promise.resolve(preloadedVoice) : loadFrenchVoice()).catch(
							(error) => {
								frenchVoice = undefined;
								throw error;
							},
						);
						yield* renderFrench(runtime, frenchPhonemize, text, options.speed, await frenchVoice);
					})();
				}
				// Explicitly close the splitter: kokoro-js 1.2.1 leaves its string-input stream open.
				const splitter = new TextSplitterStream();
				for (const chunk of splitSpeechText(text)) splitter.push(chunk + '\n');
				splitter.close();
				return runtime.stream(splitter, {
					voice: options.voice as keyof typeof runtime.voices,
					speed: options.speed,
				});
			},
		};
	}

	private async render(text: string, voice: string, rate: number, language: string): Promise<SpeechResult> {
		const engine = await this.engine();
		if (this.disposed) throw new Error('KokoroSpeech disposed');
		const selected = engine.voices[voice];
		if (!selected) throw new RangeError(`Unknown Kokoro voice: ${voice}`);
		if (selected.language.toLowerCase() !== language.toLowerCase())
			throw new RangeError(`Voice ${voice} speaks ${selected.language}, not ${language}`);
		const chunks: Float32Array[] = [];
		let length = 0;
		for await (const { audio } of engine.stream(text, { voice, speed: rate })) {
			if (this.disposed) throw new Error('KokoroSpeech disposed');
			if (audio.sampling_rate !== 24000) throw new Error('Unexpected Kokoro sample rate');
			chunks.push(audio.audio.slice());
			length += audio.audio.length;
		}
		const samples = new Float32Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			samples.set(chunk, offset);
			offset += chunk.length;
		}
		return { samples, sampleRate: 24000 };
	}
}

function copyResult(result: SpeechResult): SpeechResult {
	return { samples: result.samples.slice(), sampleRate: result.sampleRate };
}

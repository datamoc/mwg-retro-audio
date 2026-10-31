export interface BrowserSpeakOptions {
	/** BCP 47 language tag (default fr-FR). */
	language?: string;
	/** Voice URI or name from voices(); omitted to use a matching language. */
	voice?: string;
	/** Only use voices marked local by the browser (default false). */
	localOnly?: boolean;
	rate?: number;
	/** Relative pitch, 0..2, default 1 (not Hz). */
	pitch?: number;
	volume?: number;
}

/** Native browser/OS speech playback. No PCM output or Web Audio routing. */
export class BrowserSpeech {
	private readonly pending = new Map<SpeechSynthesisUtterance, (error?: Error) => void>();
	private disposed = false;

	static get supported(): boolean {
		return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
	}

	constructor(
		private readonly engine: SpeechSynthesis = globalThis.speechSynthesis,
		private readonly makeUtterance: (text: string) => SpeechSynthesisUtterance = (text) =>
			new SpeechSynthesisUtterance(text),
	) {
		if (!engine) throw new Error('Native speech is unavailable in this environment');
	}

	/** May initially be empty; browsers announce newly loaded voices with voiceschanged. */
	voices(): SpeechSynthesisVoice[] {
		return this.engine.getVoices();
	}

	/** Wait briefly for asynchronously loaded voices. */
	ready(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
		if (this.disposed) return Promise.reject(new Error('BrowserSpeech disposed'));
		const voices = this.voices();
		if (voices.length) return Promise.resolve(voices);
		return new Promise((resolve) => {
			const finish = (): void => {
				clearTimeout(timer);
				this.engine.removeEventListener('voiceschanged', changed);
				resolve(this.voices());
			};
			const changed = (): void => {
				if (this.voices().length) finish();
			};
			const timer = setTimeout(finish, timeoutMs);
			this.engine.addEventListener('voiceschanged', changed);
			changed();
		});
	}

	/** Call from a user interaction; resolves when the line finishes, rejects on cancellation or failure. */
	speak(text: string, options: BrowserSpeakOptions = {}): Promise<void> {
		if (this.disposed) return Promise.reject(new Error('BrowserSpeech disposed'));
		if (!text.trim()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const utterance = this.makeUtterance(text);
			utterance.lang = options.language ?? 'fr-FR';
			const language = utterance.lang.toLowerCase().replaceAll('_', '-');
			const voices = this.voices().filter((voice) => !options.localOnly || voice.localService);
			let voice: SpeechSynthesisVoice | undefined;
			if (options.voice) {
				voice = voices.find((v) => v.voiceURI === options.voice || v.name === options.voice);
				if (!voice) throw new Error(`Speech voice unavailable: ${options.voice}`);
			} else {
				const matching = voices.filter((v) => v.lang.toLowerCase().replaceAll('_', '-') === language);
				const candidates = matching.length
					? matching
					: voices.filter((v) => v.lang.toLowerCase().split(/[-_]/)[0] === language.split('-')[0]);
				voice = candidates.find((v) => v.default) ?? candidates[0];
			}
			if (options.localOnly && !voice) throw new Error(`No local speech voice for ${utterance.lang}`);
			utterance.voice = voice ?? null;
			utterance.rate = bounded(options.rate ?? 1, 0.1, 10);
			utterance.pitch = bounded(options.pitch ?? 1, 0, 2);
			utterance.volume = bounded(options.volume ?? 1, 0, 1);
			const finish = (error?: Error): void => {
				this.pending.delete(utterance);
				utterance.onend = null;
				utterance.onerror = null;
				if (error) reject(error);
				else resolve();
			};
			utterance.onend = () => finish();
			utterance.onerror = (event) => finish(new Error(`Native speech failed: ${event.error}`));
			this.pending.set(utterance, finish);
			try {
				this.engine.speak(utterance);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	/** Browser cancellation affects the entire page's shared native speech queue. */
	cancel(): void {
		for (const finish of this.pending.values()) finish(new Error('Native speech canceled'));
		this.engine.cancel();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pending.size) this.cancel();
	}
}

function bounded(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) throw new RangeError('Speech controls must be finite');
	return Math.max(min, Math.min(max, value));
}

import { PSGVoice } from './PSGVoice.ts';

/** chip families with a simple one-oscillator voice, and the waveform each maps to */
const VOICE_WAVEFORMS = {
	ay: 'square',
	ym2149: 'square',
	ay8910: 'square',
	st: 'square',
	psg: 'square',
	nes: 'square',
	'2a03': 'square',
	gameboy: 'square',
	sn76489: 'square',
	'pc-speaker': 'square',
	'apple2-speaker': 'square',
	'pcm-dac': 'square',
	mockingboard: 'square',
	ym2612: 'square',
	ym2151: 'square',
	opl2: 'square',
	opl3: 'square',
	saa1099: 'square',
	vrc6: 'square',
	mmc5: 'square',
	'sunsoft-5b': 'square',
	'namco-163': 'square',
	fds: 'square',
	sid: 'sawtooth',
	c64: 'sawtooth',
	square: 'square',
	sawtooth: 'sawtooth',
	triangle: 'triangle',
	sine: 'sine',
} as const;

export type RetroVoiceChip = keyof typeof VOICE_WAVEFORMS;

const NOTE_OFFSETS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** seconds of look-ahead so the first note is scheduled on the audio clock, not in the past */
const SCHEDULE_LEAD = 0.02;

function clampVolume(volume: number): number {
	return Math.max(0, Math.min(1, volume));
}

/**
 * A MIDI note number or a scientific pitch name (`'A4'`, `'C#5'`, `'Db3'`) to hertz.
 * `null`/`undefined` is a rest and is handled by the sequence, not here.
 */
export function noteToFrequency(note: number | string): number {
	let midi: number;
	if (typeof note === 'number') {
		midi = note;
	} else {
		const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(note.trim());
		if (!match) throw new RangeError(`invalid note '${note}' (use a MIDI number or a name such as C#4)`);
		const semitone = NOTE_OFFSETS[match[1].toUpperCase()] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
		midi = (Number(match[3]) + 1) * 12 + semitone;
	}
	if (!Number.isFinite(midi) || midi < 0 || midi > 127) throw new RangeError(`note out of MIDI range: ${note}`);
	return 440 * 2 ** ((midi - 69) / 12);
}

/** one note of a `RetroVoice` sequence; `at` and `duration` are seconds from the sequence start */
export interface RetroNote {
	/** MIDI note number or pitch name, or null for a rest */
	note: number | string | null;
	/** seconds from the start of the sequence */
	at: number;
	/** seconds the note sounds */
	duration: number;
	/** 0 to 1, defaults to the sequence or voice volume */
	volume?: number;
}

export interface RetroSequenceOptions {
	/** absolute AudioContext time to start at; defaults to the current time */
	at?: number;
	/** repeat the note list until `stop()`; the first two passes are scheduled ahead of the clock */
	loop?: boolean;
	/** level for notes that carry none; defaults to the voice's current volume */
	volume?: number;
}

/** a scheduled note list; `stop()` silences the voice and cancels a looping sequence */
export interface RetroSequence {
	readonly startedAt: number;
	/** `Infinity` while a looping sequence runs */
	readonly endsAt: number;
	readonly notes: number;
	stop(): void;
}

export interface RetroVoiceOptions {
	context: AudioContext;
	destination: AudioNode;
	/** chip family; selects the waveform (`square` when omitted) */
	chip?: RetroVoiceChip;
	/** overrides the waveform selected by `chip` */
	waveform?: OscillatorType;
	/** 0 to 1, 0.2 when omitted (the driver's default headroom) */
	volume?: number;
}

/**
 * One chiptune voice over `PSGVoice`: a monophonic oscillator with scheduled notes. It is the small
 * live counterpart of rendering a file, for menu jingles, UI blips and scripted music.
 *
 * @example
 * ```ts
 * const voice = retroVoice({ chip: 'nes', context, destination: driver.getDestination() });
 * voice.playNotes([
 * 	{ note: 'C5', at: 0, duration: 0.12 },
 * 	{ note: 'E5', at: 0.12, duration: 0.12 },
 * 	{ note: 'G5', at: 0.24, duration: 0.24 },
 * ]);
 * ```
 */
export class RetroVoice {
	private readonly voice: PSGVoice;
	private readonly context: AudioContext;
	private readonly timers = new Set<ReturnType<typeof setInterval>>();
	private generation = 0;
	private gain: number;

	constructor(options: RetroVoiceOptions) {
		const chip = options.chip ?? 'ay';
		const waveform = options.waveform ?? VOICE_WAVEFORMS[chip];
		if (!waveform) throw new RangeError(`unknown retro voice chip '${chip}'`);
		this.context = options.context;
		this.gain = clampVolume(options.volume ?? 0.2);
		this.voice = new PSGVoice(options.context, options.destination);
		this.voice.setWaveform(waveform);
		this.voice.setVolume(this.gain);
	}

	/** set the frequency now, or at an absolute AudioContext time */
	setFrequency(hz: number, at?: number): void {
		this.voice.setFrequency(hz, at);
	}

	/** set the level now, or at an absolute AudioContext time; values are clamped to 0..1 */
	setVolume(volume: number, at?: number): void {
		this.gain = clampVolume(volume);
		this.voice.setVolume(this.gain, at);
	}

	/** silence the voice and cancel any looping sequence */
	stop(at?: number): void {
		this.generation++;
		this.clearTimers();
		this.voice.stop(at);
	}

	/** schedule a monophonic note list; a new sequence replaces the previous one */
	playNotes(notes: readonly RetroNote[], options: RetroSequenceOptions = {}): RetroSequence {
		this.stop();
		const generation = this.generation;
		const startAt = Math.max(this.context.currentTime, options.at ?? this.context.currentTime) + SCHEDULE_LEAD;
		const sorted = notes.map(normaliseNote).sort((a, b) => a.at - b.at);
		const length = sorted.reduce((end, note) => Math.max(end, note.at + note.duration), 0);
		if (length <= 0) throw new RangeError('a retro sequence needs at least one note with a duration');
		const defaultVolume = options.volume === undefined ? this.gain : clampVolume(options.volume);

		const schedule = (base: number): void => {
			for (const note of sorted) {
				if (note.note === null) continue;
				const frequency = noteToFrequency(note.note);
				const volume = note.volume === undefined ? defaultVolume : clampVolume(note.volume);
				this.voice.setFrequency(frequency, base + note.at);
				this.voice.setVolume(volume, base + note.at);
				this.voice.setVolume(0, base + note.at + note.duration);
			}
			// the sequence is silent after its last note, even when the list ends with a rest
			this.voice.setVolume(0, base + length);
		};

		schedule(startAt);
		let endsAt = startAt + length;
		if (options.loop) {
			// schedule one pass ahead; the timer then keeps the horizon one pass in front of the clock
			schedule(startAt + length);
			let next = 2;
			const period = Math.max(25, length * 1000);
			const timer = setInterval(() => {
				schedule(startAt + next * length);
				next++;
			}, period);
			this.timers.add(timer);
			endsAt = Number.POSITIVE_INFINITY;
		}

		return {
			startedAt: startAt,
			get endsAt(): number {
				return endsAt;
			},
			notes: sorted.length,
			stop: () => {
				if (generation === this.generation) this.stop();
			},
		};
	}

	dispose(): void {
		this.stop();
		this.voice.dispose();
	}

	private clearTimers(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.timers.clear();
	}
}

function normaliseNote(note: RetroNote): RetroNote {
	if (!Number.isFinite(note.at) || note.at < 0)
		throw new RangeError(`note start must be a positive time: ${note.at}`);
	if (!Number.isFinite(note.duration) || note.duration <= 0)
		throw new RangeError(`note duration must be positive: ${note.duration}`);
	if (note.note !== null) noteToFrequency(note.note); // validates names and MIDI range
	if (note.volume !== undefined && (!Number.isFinite(note.volume) || note.volume < 0 || note.volume > 1))
		throw new RangeError(`note volume must be between 0 and 1: ${note.volume}`);
	return { ...note };
}

/** create a `RetroVoice`; see `RetroVoiceOptions` */
export function retroVoice(options: RetroVoiceOptions): RetroVoice {
	return new RetroVoice(options);
}

/** convenience form of `voice.playNotes(notes, options)` */
export function retroSequencer(
	voice: RetroVoice,
	notes: readonly RetroNote[],
	options?: RetroSequenceOptions,
): RetroSequence {
	return voice.playNotes(notes, options);
}

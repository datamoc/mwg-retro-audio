/** A short Web Audio tone, specified as a base frequency with optional semitone transposition. */
export interface ToneOptions {
	/** Base note frequency in Hz. */
	frequency: number;
	/** Oscillator waveform; defaults to a square wave. */
	waveform?: OscillatorType;
	/** Duration in seconds. */
	duration: number;
	/** Transposition from the base frequency in semitones, including fractions. */
	semitones?: number;
	/** Linear output level from 0 to 1; defaults to 0.2. */
	volume?: number;
	/** Absolute start time in the AudioContext timeline; defaults to currentTime. */
	startAt?: number;
	/** Optional destination; defaults to the context destination. */
	destination?: AudioNode;
}

/**
 * Play a precisely timed oscillator tone on an existing Web Audio context.
 *
 * @example
 * ```ts
 * playTone(context, { frequency: 226, waveform: 'square', duration: 0.016 });
 * playTone(context, { frequency: 459, semitones: 1, waveform: 'square', duration: 0.096 });
 * ```
 */
export function playTone(context: BaseAudioContext, options: ToneOptions): OscillatorNode {
	const { frequency, duration } = options;
	if (!Number.isFinite(frequency) || frequency <= 0) throw new RangeError('frequency must be a positive number');
	if (!Number.isFinite(duration) || duration <= 0) throw new RangeError('duration must be a positive number');
	const semitones = options.semitones ?? 0;
	if (!Number.isFinite(semitones)) throw new RangeError('semitones must be a finite number');
	const volume = options.volume ?? 0.2;
	if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('volume must be between 0 and 1');
	const startAt = options.startAt ?? context.currentTime;
	if (!Number.isFinite(startAt)) throw new RangeError('startAt must be a finite number');

	const start = Math.max(context.currentTime, startAt);
	const oscillator = context.createOscillator();
	const gain = context.createGain();
	oscillator.type = options.waveform ?? 'square';
	oscillator.frequency.setValueAtTime(frequency * 2 ** (semitones / 12), start);
	gain.gain.setValueAtTime(volume, start);
	gain.gain.setValueAtTime(0, start + duration);
	oscillator.connect(gain);
	gain.connect(options.destination ?? context.destination);
	oscillator.start(start);
	oscillator.stop(start + duration);
	return oscillator;
}

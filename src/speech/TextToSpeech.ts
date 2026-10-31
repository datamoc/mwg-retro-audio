import { FormantSynth, type SourceShape, type SpeechFrame } from './FormantSynth.ts';
import { phonemesToSyllables, textToPhonemes, type SpeechLanguage } from './g2p.ts';
import { PHONEMES } from './phonemes.ts';

export interface SpeakOptions {
	sampleRate?: number;
	/** base pitch in Hz (default 120) */
	pitch?: number;
	/** speed factor, 1 = nominal */
	rate?: number;
	/** how far the pitch falls over the phrase, as a share of the base pitch (default 0.25, 0 = monotone) */
	declination?: number;
	/** scale of the formants: 1 is an adult male voice, about 1.17 a woman, 1.3 a child */
	formantScale?: number;
	/** vibrato depth as a share of the pitch (default 0 when speaking, 0.006 when singing) */
	vibrato?: number;
	/** number of slightly detuned voices mixed together, for a fuller voice (singing only, default 1) */
	chorus?: number;
	/** silence between words in seconds (default 0.04) */
	wordPause?: number;
	/** how much the last vowel of each word is raised in pitch, as a share of the pitch (default 0.04); it is also held longer */
	accent?: number;
	/** share of aspiration noise in the voiced sounds, 0 (default) to 1: a soft, airy phonation */
	breathiness?: number;
	/** whisper: no voicing at all, only noise shaped by the formants */
	whisper?: boolean;
	/** random variation of each pitch period (default 0.004 when speaking, 0.003 when singing) */
	jitter?: number;
	source?: SourceShape;
}

/** A sung syllable: phonemes separated by spaces, the MIDI note carried by its vowel, the length in seconds */
export interface SungSyllable {
	phonemes: string;
	note: number;
	duration: number;
}

const midiToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

function frameOf(
	symbol: string,
	f0: number,
	duration: number,
	scale = 1,
	phonation: { breathiness?: number; whisper?: boolean } = {},
): SpeechFrame {
	const p = PHONEMES[symbol];
	if (!p) throw new RangeError(`unknown phoneme '${symbol}'`);
	const whisper = phonation.whisper === true && p.voiced;
	return {
		duration,
		f0: p.voiced && !whisper ? f0 : 0,
		formants: p.formants.map((f) => f * scale) as unknown as SpeechFrame['formants'],
		bandwidths: p.bandwidths,
		voice: p.voiced && !whisper ? (p.vowel ? 1 : 0.6) : 0,
		// a whisper is noise through the formants, a breathy voice has some aspiration mixed into the voicing
		noise: whisper
			? p.vowel
				? 0.5
				: Math.max(p.noise, 0.3)
			: p.noise + (p.voiced ? 0.12 * (phonation.breathiness ?? 0) : 0),
	};
}

/**
 * Speak a phoneme string (space separated symbols, see `PHONEMES`; `-` is a word break and `_` a longer pause) with
 * a falling pitch and a small accent on the last vowel of each word
 */
export function speakPhonemes(phonemes: string, options: SpeakOptions = {}): Float32Array {
	const symbols = phonemes.split(/\s+/).filter(Boolean);
	const rate = Math.max(0.25, Math.min(4, options.rate ?? 1));
	const base = options.pitch ?? 120;
	const accent = options.accent ?? 0.04;
	const isVowel = (i: number): boolean => Boolean(PHONEMES[symbols[i]]?.vowel);
	// the last vowel of a word: the next symbol that is not a consonant is a break or the end
	const wordFinal = (i: number): boolean => {
		if (!isVowel(i)) return false;
		for (let j = i + 1; j < symbols.length; j++) {
			if (symbols[j] === '-' || symbols[j] === '_') return true;
			if (isVowel(j)) return false;
		}
		return true;
	};
	const lengths = symbols.map((s, i) => {
		const natural = s === '-' ? (options.wordPause ?? PHONEMES['-'].duration) : (PHONEMES[s]?.duration ?? 0);
		return (natural * (wordFinal(i) ? 1.3 : 1)) / rate;
	});
	const total = lengths.reduce((a, b) => a + b, 0);
	let elapsed = 0;
	const frames = symbols.map((s, i) => {
		const f0 =
			base *
			(1.1 - (options.declination ?? 0.25) * (elapsed / Math.max(total, 1e-6))) *
			(wordFinal(i) ? 1 + accent : 1);
		elapsed += lengths[i];
		return frameOf(s, f0, lengths[i], options.formantScale, options);
	});
	return new FormantSynth({
		sampleRate: options.sampleRate,
		source: options.source,
		vibrato: options.vibrato,
		jitter: options.jitter ?? 0.004,
	}).render(frames);
}

/**
 * Sing a list of syllables. Consonants keep their natural length; the vowel absorbs the rest of the syllable, so
 * every syllable lasts exactly `duration` seconds and the score timing is preserved.
 */
export function sing(score: readonly SungSyllable[], options: Omit<SpeakOptions, 'pitch' | 'rate'> = {}): Float32Array {
	const voices = Math.max(1, Math.round(options.chorus ?? 1));
	let mixed: Float32Array | undefined;
	for (let v = 0; v < voices; v++) {
		// the voices of a chorus are detuned by a few cents each way and have their own vibrato phase
		const cents = voices === 1 ? 0 : ((v / (voices - 1)) * 2 - 1) * 14;
		const detune = 2 ** (cents / 1200);
		const frames: SpeechFrame[] = [];
		for (const syllable of score) {
			const symbols = syllable.phonemes.split(/\s+/).filter(Boolean);
			const f0 = midiToHz(syllable.note) * detune;
			const fixed = symbols.reduce((sum, s) => sum + (PHONEMES[s]?.vowel ? 0 : (PHONEMES[s]?.duration ?? 0)), 0);
			const vowels = symbols.filter((s) => PHONEMES[s]?.vowel).length;
			const scale = fixed > syllable.duration * 0.6 ? (syllable.duration * 0.6) / fixed : 1;
			const vowelDuration = (syllable.duration - fixed * scale) / Math.max(1, vowels);
			for (const s of symbols) {
				const natural = PHONEMES[s]?.duration ?? 0;
				const duration = PHONEMES[s]?.vowel ? vowelDuration : natural * scale;
				frames.push(frameOf(s, f0, duration, options.formantScale, options));
			}
		}
		const voice = new FormantSynth({
			sampleRate: options.sampleRate,
			source: options.source ?? 'saw',
			vibrato: options.vibrato ?? 0.006,
			vibratoPhase: voices === 1 ? 0 : v / voices,
			jitter: options.jitter ?? 0.003,
		}).render(frames);
		if (!mixed) mixed = new Float32Array(voice.length);
		for (let i = 0; i < voice.length; i++) mixed[i] += voice[i] / voices;
	}
	return mixed ?? new Float32Array(0);
}

/** Speak normal text: the words are converted to phonemes with the rules of `language` */
export function speakText(text: string, language: SpeechLanguage = 'fr', options: SpeakOptions = {}): Float32Array {
	return speakPhonemes(textToPhonemes(text, language, { wordBreaks: true }), options);
}

/** A note of a melody: MIDI note and length in seconds */
export interface MelodyNote {
	note: number;
	duration: number;
}

/**
 * Sing text to a melody: the text is split into syllables and each note of the score carries one syllable. When the
 * text has more syllables than the melody has notes the extra syllables are dropped; when it has fewer, the last
 * syllable is repeated on the extra notes.
 */
export function singText(
	text: string,
	melody: readonly MelodyNote[],
	language: SpeechLanguage = 'fr',
	options: Omit<SpeakOptions, 'pitch' | 'rate'> = {},
): Float32Array {
	const syllables = phonemesToSyllables(textToPhonemes(text, language));
	const score: SungSyllable[] = melody.map((m, i) => ({
		phonemes: syllables[Math.min(i, syllables.length - 1)] ?? '_',
		note: m.note,
		duration: m.duration,
	}));
	return sing(score, options);
}

/**
 * Sing lyrics given syllable by syllable, one for each note of the melody. A syllable is written as text and
 * converted with the rules of `language` (the mute e is sung), or as explicit phonemes when it starts with `/`
 * (for example `/t w I N`), which is what to use for English, where spelling is a poor guide.
 */
export function singLyrics(
	syllables: readonly string[],
	melody: readonly MelodyNote[],
	language: SpeechLanguage = 'fr',
	options: Omit<SpeakOptions, 'pitch' | 'rate'> = {},
): Float32Array {
	if (syllables.length !== melody.length)
		throw new RangeError(`${syllables.length} syllables for ${melody.length} notes`);
	const score: SungSyllable[] = melody.map((m, i) => ({
		phonemes: syllables[i].startsWith('/')
			? syllables[i].slice(1).trim()
			: textToPhonemes(syllables[i], language, { sung: true }),
		note: m.note,
		duration: m.duration,
	}));
	return sing(score, options);
}

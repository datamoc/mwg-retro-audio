import { DrumMachine, type DrumHit } from '../sfx/DrumMachine.ts';
import { phonemesToSyllables, textToPhonemes, type SpeechLanguage } from '../speech/g2p.ts';
import { sing, speakPhonemes } from '../speech/TextToSpeech.ts';
import { vocode } from '../speech/Vocoder.ts';
import { Random } from './random.ts';
import { applyToneGains, toneMatchGains } from './tone.ts';
import { applyScene, DEFAULT_FEEL, SCALES, SCENES, STYLES, type StyleSpec, type Timbre } from './styles.ts';
import { midiToHz, mixLooped, renderNote, type NoteShape } from './voices.ts';

export interface ComposeOptions {
	/** a style id of `STYLES`, or a custom `StyleSpec` */
	style: string | StyleSpec;
	/** a mood for a game situation (`forest`, `dungeon`, `village`, `fight`, `boss`, `victory`, see `SCENES`) */
	scene?: string;
	/** the same seed always gives the same cue */
	seed: number | string;
	/** wanted length in seconds; the cue is rounded to a whole number of bars so that it loops seamlessly */
	duration: number;
	sampleRate?: number;
	/**
	 * What the voice line does: `speak` pronounces `text` (or `phonemes`) normally at the start of every eighth bar,
	 * `sing` sings syllables to the generated melody every fourth bar, `none` leaves it out. The default is `speak`
	 * when a `text` is given and `sing` otherwise; styles with a vocoder voice have a voice line by default, the other
	 * styles only when a `text`, `phonemes` or `voice` is given (then a plain formant voice is used, without vocoder)
	 */
	voice?: 'sing' | 'speak' | 'none';
	/** phonemes for `speak` (default: a short neutral word) */
	phonemes?: string;
	/**
	 * Plain text for the voice line instead of `phonemes` / the neutral syllables: it is spoken as it is, or its
	 * syllables are sung to the generated melody, one per note, cycling through the text
	 */
	text?: string;
	/** language of `text` (default French) */
	language?: SpeechLanguage;
	/** Prerendered mono speech at sampleRate; replaces formant speech in speak mode (also feeds the vocoder). */
	voiceSamples?: Float32Array;
}

/** A rendered cue; played in a loop it repeats with no click and no gap */
export interface Cue {
	left: Float32Array;
	right: Float32Array;
	sampleRate: number;
	style: StyleSpec;
	seed: number | string;
	/** exact tempo of the cue in BPM (the style's tempo) */
	tempo: number;
	bars: number;
	/** length in seconds, `bars` whole bars */
	seconds: number;
	/** true: the end joins the start seamlessly */
	loop: true;
	/** the voice line alone, before ducking and tone matching, to filter or mix it again (absent without a voice line) */
	voiceTrack?: { left: Float32Array; right: Float32Array };
}

const PROGRESSIONS: Readonly<Record<StyleSpec['mode'], readonly (readonly number[])[]>> = {
	minor: [
		[0, 5, 2, 6],
		[0, 3, 5, 4],
		[0, 6, 5, 6],
	],
	major: [
		[0, 4, 5, 3],
		[0, 5, 3, 4],
		[0, 3, 4, 3],
	],
	dorian: [
		[0, 3, 0, 6],
		[0, 3, 6, 3],
	],
	mixolydian: [
		[0, 6, 3, 0],
		[0, 6, 4, 0],
	],
	phrygian: [
		[0, 1, 0, 6],
		[0, 5, 1, 0],
	],
};

/** Syllables of the sung voice line: neutral sounds that do not spell any existing lyric */
const SYLLABLES = ['d a', 'm o', 'l u', 'n i', 'w o', 'r a', 'a', 'o'];

interface MotifNote {
	step: number;
	length: number;
	/** scale steps above the root of the bar's chord */
	offset: number;
}

const resolveStyle = (style: string | StyleSpec, scene?: string): StyleSpec => {
	let found: StyleSpec;
	if (typeof style !== 'string') found = style;
	else {
		const named = STYLES[style];
		if (!named) throw new RangeError(`unknown style '${style}'`);
		found = named;
	}
	if (!scene) return found;
	const mood = SCENES[scene];
	if (!mood) throw new RangeError(`unknown scene '${scene}'`);
	return applyScene(found, mood);
};

/** Compose and render a looping cue from a style, a seed and a duration */
export function composeCue(options: ComposeOptions): Cue {
	const style = resolveStyle(options.style, options.scene);
	const feel = { ...DEFAULT_FEEL, ...style.feel };
	const rate = options.sampleRate ?? 44100;
	const rng = new Random(`${style.id}:${options.seed}`);
	const beat = 60 / style.tempo;
	const barSeconds = 4 * beat;
	const bars = Math.max(1, Math.round(options.duration / barSeconds));
	const total = Math.round(bars * barSeconds * rate);
	const left = new Float32Array(total);
	const right = new Float32Array(total);
	const stepSeconds = beat / 4;
	const stepSample = (bar: number, step: number): number => Math.round((bar * 16 + step) * stepSeconds * rate);

	const scale = SCALES[style.mode];
	const tonicMidi = 36 + style.tonic;
	/** MIDI note of scale index `index` (may be negative or above 6) at octave offset `octave` */
	const scaleNote = (index: number, octave = 0): number => {
		const o = Math.floor(index / 7);
		return tonicMidi + 12 * (o + octave) + scale[((index % 7) + 7) % 7];
	};

	const progression = rng.pick(PROGRESSIONS[style.mode]);
	const roots = Array.from({ length: bars }, (_, bar) => {
		const root = progression[bar % 4];
		return bar % 8 === 7 && rng.chance(0.5) ? (root + 1) % 7 : root; // a variation at the end of a phrase
	});

	// drums
	const drums = new DrumMachine({ sampleRate: rate });
	const hits: DrumHit[] = [];
	const g = style.groove;
	hits.push(...drums.pattern('kick', g.kick, style.tempo, 4, bars));
	hits.push(...drums.pattern('snare', g.snare, style.tempo, 4, bars));
	hits.push(...drums.pattern('hat', g.hat, style.tempo, 4, bars));
	hits.push(...drums.pattern('openHat', g.openHat, style.tempo, 4, bars));
	if (g.tom) hits.push(...drums.pattern('tom', g.tom, style.tempo, 4, bars));
	const drumTrack = drums.render(hits, bars * barSeconds);
	const gainDrums = 0.3 * feel.drumLevel;
	for (let i = 0; i < total; i++) {
		left[i] += drumTrack[i] * gainDrums;
		right[i] += drumTrack[i] * gainDrums;
	}

	const note = (timbre: Timbre, midi: number, seconds: number, shape: NoteShape): Float32Array =>
		renderNote(timbre, midiToHz(midi), seconds, rate, shape);

	// bass
	const bassShape: NoteShape = { attack: 0.004, release: 0.05, decay: style.instruments.bass === 'fm' ? 3 : 1.5 };
	for (let bar = 0; bar < bars; bar++) {
		const pattern = g.bass;
		for (let step = 0; step < 16; step++) {
			const c = pattern[step];
			if (c === '.') continue;
			let next = step + 1;
			while (next < 16 && pattern[next] === '.') next++;
			const index = roots[bar] + (c === 'F' ? 4 : 0);
			const midi = scaleNote(index, feel.bassOctave) + (c === 'O' ? 12 : 0);
			const sound = note(style.instruments.bass, midi, Math.min(next - step, 4) * stepSeconds * 0.9, bassShape);
			mixLooped(left, right, sound, stepSample(bar, step), 0.42, 0.42);
		}
	}

	// chords
	const chordShape: NoteShape = { attack: 0.02, release: 0.1, decay: style.instruments.chords === 'stabs' ? 6 : 0.4 };
	const chordTimbre: Timbre = style.chip === 'psg' ? 'square' : style.instruments.lead === 'fm' ? 'fm' : 'saw';
	for (let bar = 0; bar < bars; bar++) {
		const tones = [0, 2, 4].map((k) => scaleNote(roots[bar] + k, 2));
		if (style.instruments.chords === 'pad') {
			for (const midi of tones)
				mixLooped(
					left,
					right,
					note(chordTimbre, midi, barSeconds, chordShape),
					stepSample(bar, 0),
					0.07 * feel.chordLevel,
					0.07 * feel.chordLevel,
				);
		} else if (style.instruments.chords === 'stabs') {
			for (const step of [2, 6, 10, 14])
				for (const midi of tones)
					mixLooped(
						left,
						right,
						note(chordTimbre, midi, stepSeconds * 1.5, chordShape),
						stepSample(bar, step),
						0.06 * feel.chordLevel,
						0.08 * feel.chordLevel,
					);
		} else {
			for (let step = 0; step < 16; step++)
				mixLooped(
					left,
					right,
					note('square', tones[step % 3] + 12, stepSeconds * 0.8, { attack: 0.002, release: 0.02, decay: 8 }),
					stepSample(bar, step),
					0.09 * feel.chordLevel,
					0.09 * feel.chordLevel,
				);
		}
	}

	// the voice line is planned first: the lead leaves room at the top of a phrase
	const voiceMode =
		options.voice ?? (options.text !== undefined || options.voiceSamples !== undefined ? 'speak' : 'sing');
	const vocoder = style.instruments.voice === 'vocoder';
	const voiceOn =
		voiceMode !== 'none' &&
		(vocoder ||
			options.text !== undefined ||
			options.phonemes !== undefined ||
			options.voice !== undefined ||
			options.voiceSamples !== undefined);

	// lead: a two bar motif relative to each chord root, answered with a variation every fourth bar
	const motif: MotifNote[] = [];
	for (let step = 0; step < 32;) {
		const length = rng.pick([1, 2, 2, 3, 4]);
		if (rng.chance(feel.leadDensity) || step % 4 === 0)
			motif.push({
				step,
				length,
				offset: step % 4 === 0 ? rng.pick([0, 2, 4, 7]) : rng.pick([-1, 0, 1, 2, 3, 4, 5]),
			});
		step += length;
	}
	const leadShape: NoteShape = { attack: 0.006, release: 0.08, decay: style.instruments.lead === 'fm' ? 2.5 : 1 };
	for (let bar = 0; bar < bars; bar++) {
		if (bar % 8 < 2 && voiceOn) continue; // leave room for the voice at the top of a phrase
		for (const m of motif) {
			if (Math.floor(m.step / 16) !== bar % 2) continue;
			const varied = bar % 4 === 3 && m.step % 16 >= 8;
			const index = roots[bar] + m.offset + (varied ? 2 : 0);
			const sound = note(
				style.instruments.lead,
				scaleNote(index, 2 + feel.leadOctave),
				m.length * stepSeconds * 0.9,
				leadShape,
			);
			mixLooped(left, right, sound, stepSample(bar, m.step % 16), 0.2, 0.15);
		}
	}

	// voice line, on its own track so that the music can be lowered under it
	const voiceLeft = new Float32Array(total);
	const voiceRight = new Float32Array(total);
	if (voiceOn) {
		const language = options.language ?? 'fr';
		const textPhonemes =
			options.text !== undefined ? textToPhonemes(options.text, language, { wordBreaks: true }) : undefined;
		const textSyllables = textPhonemes ? phonemesToSyllables(textPhonemes) : [];
		const sawCarrier = (hz: number, length: number): Float32Array =>
			Float32Array.from({ length }, (_, i) => 2 * ((hz * i) / rate - Math.floor((hz * i) / rate + 0.5)));
		const normalise = (x: Float32Array, level: number): Float32Array => {
			let top = 0;
			for (const v of x) top = Math.max(top, Math.abs(v));
			return top > 0 ? x.map((v) => (v * level) / top) : x;
		};
		/** the vocoded voice, blended with some of the dry voice so that the words stay clear */
		const robot = (dry: Float32Array, carrier: Float32Array): Float32Array => {
			const wet = normalise(vocode(dry, carrier, { sampleRate: rate, bands: 20 }), 1);
			const clear = normalise(dry, 1);
			return Float32Array.from(wet, (w, i) => 0.65 * w + 0.45 * clear[i]);
		};
		if (voiceMode === 'speak') {
			const phonemes = textPhonemes ?? options.phonemes ?? 'h a l o';
			for (let bar = 0; bar < bars; bar += 8) {
				// each phrase is spoken on the root of the chord of its bar, so that the voice stays in the key
				const hz = midiToHz(scaleNote(roots[bar], 1));
				const dry =
					options.voiceSamples ??
					speakPhonemes(phonemes, {
						sampleRate: rate,
						pitch: hz / 1.1,
						declination: 0,
						accent: 0,
						source: vocoder ? 'saw' : 'glottal',
					});
				const line = vocoder ? robot(dry, sawCarrier(hz, dry.length)) : dry;
				mixLooped(voiceLeft, voiceRight, normalise(line, 0.9), stepSample(bar, 0), 1, 1);
			}
		} else {
			for (let bar = 0; bar < bars; bar += 4) {
				const syllables = Array.from({ length: 8 }, (_, k) => ({
					phonemes: textSyllables.length
						? textSyllables[((bar >> 2) * 8 + k) % textSyllables.length]
						: rng.pick(SYLLABLES),
					note: scaleNote(roots[(bar + (k >> 1)) % bars] + rng.pick([0, 2, 4]), 1),
					duration: beat,
				}));
				const dry = sing(syllables, { sampleRate: rate, source: vocoder ? 'glottal' : 'saw' });
				let line = dry;
				if (vocoder) {
					const carrier = new Float32Array(dry.length);
					let at = 0;
					for (const syllable of syllables) {
						const n = Math.round(syllable.duration * rate);
						const wave = sawCarrier(midiToHz(syllable.note), n);
						carrier.set(wave.subarray(0, Math.max(0, Math.min(n, carrier.length - at))), at);
						at += n;
					}
					line = robot(dry, carrier);
				}
				mixLooped(voiceLeft, voiceRight, normalise(line, 0.9), stepSample(bar, 0), 1, 1);
			}
		}
	}

	// the music is lowered under the voice, then the voice is added
	let musicPeak = 0;
	for (let i = 0; i < total; i++) musicPeak = Math.max(musicPeak, Math.abs(left[i]), Math.abs(right[i]));
	const musicGain = musicPeak > 0 ? 0.6 / musicPeak : 1;
	const attack = 1 - Math.exp(-1 / (rate * 0.008));
	const release = 1 - Math.exp(-1 / (rate * 0.15));
	let follower = 0;
	// two passes over the loop, so that the follower already has the state of the end when the cue starts
	for (let pass = 0; pass < (voiceOn ? 2 : 1); pass++)
		for (let i = 0; i < total; i++) {
			const level = Math.abs(voiceLeft[i]);
			follower += (level - follower) * (level > follower ? attack : release);
			if (pass === (voiceOn ? 1 : 0)) {
				const duck = voiceOn ? 1 - 0.6 * Math.min(1, follower / 0.15) : 1;
				left[i] = left[i] * musicGain * duck + voiceLeft[i];
				right[i] = right[i] * musicGain * duck + voiceRight[i];
			}
		}

	// tone of the style, on the whole mix with the voice: a matching EQ towards its average spectrum, or the plain shelves of `eq`
	if (style.toneTarget) {
		// two passes: the first one moves the shape most of the way, the second one corrects what it left
		for (let pass = 0; pass < 2; pass++) {
			const mono = Float32Array.from(left, (l, i) => 0.5 * (l + right[i]));
			applyToneGains([left, right], toneMatchGains(mono, style.toneTarget, rate), rate);
		}
	} else if (style.eq) {
		for (const channel of [left, right]) shelve(channel, rate, style.eq.low, style.eq.high);
	}

	// normalise the peak
	let peak = 0;
	for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
	const gain = peak > 0 ? 0.85 / peak : 1;
	for (let i = 0; i < total; i++) {
		left[i] *= gain;
		right[i] *= gain;
	}
	return {
		left,
		right,
		sampleRate: rate,
		style,
		seed: options.seed,
		tempo: style.tempo,
		bars,
		seconds: total / rate,
		loop: true,
		voiceTrack: voiceOn ? { left: voiceLeft, right: voiceRight } : undefined,
	};
}

/** Boost or cut below 220 Hz by `lowDb` and above 2.5 kHz by `highDb` (in place): out = x + (g - 1) * band */
function shelve(x: Float32Array, rate: number, lowDb: number, highDb: number): void {
	const gl = 10 ** (lowDb / 20) - 1;
	const gh = 10 ** (highDb / 20) - 1;
	const al = 1 - Math.exp((-2 * Math.PI * 220) / rate);
	const ah = 1 - Math.exp((-2 * Math.PI * 2500) / rate);
	let low = 0;
	let highState = 0;
	for (let i = 0; i < x.length; i++) {
		const v = x[i];
		low += (v - low) * al;
		highState += (v - highState) * ah;
		x[i] = v + gl * low + gh * (v - highState);
	}
}

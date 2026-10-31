import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sing, speakPhonemes } from '../src/speech/index.ts';

const RATE = 44100;

/** magnitude of the DFT of `x` at `hz` */
function bin(x: Float32Array, hz: number): number {
	let re = 0;
	let im = 0;
	for (let i = 0; i < x.length; i++) {
		const w = (2 * Math.PI * hz * i) / RATE;
		re += x[i] * Math.cos(w);
		im += x[i] * Math.sin(w);
	}
	return Math.hypot(re, im);
}

/** pitch from the autocorrelation peak between `low` and `high` Hz, refined by parabolic interpolation */
function frequency(x: Float32Array, low: number, high: number): number {
	const acf = (lag: number): number => {
		let sum = 0;
		for (let i = RATE >> 2; i + lag < x.length; i++) sum += x[i] * x[i + lag];
		return sum;
	};
	let best = Math.floor(RATE / high);
	for (let lag = best; lag <= Math.ceil(RATE / low); lag++) if (acf(lag) > acf(best)) best = lag;
	const [a, b, c] = [acf(best - 1), acf(best), acf(best + 1)];
	return RATE / (best + (0.5 * (a - c)) / (a - 2 * b + c));
}

test('a vowel puts its energy near its formants', () => {
	const x = speakPhonemes('i i i i', { sampleRate: RATE });
	// /i/ has F2 near 2250 Hz and almost nothing at 1300 Hz
	assert.ok(bin(x, 2250) > 3 * bin(x, 1300));
});

test('different vowels give different spectra', () => {
	const a = speakPhonemes('a a a a', { sampleRate: RATE });
	const i = speakPhonemes('i i i i', { sampleRate: RATE });
	assert.ok(bin(a, 750) / bin(a, 2250) > 2 * (bin(i, 750) / bin(i, 2250)));
});

test('singing keeps the score timing exactly', () => {
	const x = sing([
		{ phonemes: 'f u N', note: 60, duration: 0.5 },
		{ phonemes: 't a w n', note: 64, duration: 0.25 },
	]);
	assert.ok(Math.abs(x.length - 0.75 * RATE) <= 4);
});

test('a sung vowel has the pitch of its note within 1%', () => {
	const x = sing([{ phonemes: 'a', note: 57, duration: 1 }]);
	assert.ok(Math.abs(frequency(x, 150, 300) / 220 - 1) < 0.01);
});

test('speech is deterministic and rejects unknown phonemes', () => {
	assert.deepEqual(speakPhonemes('s a'), speakPhonemes('s a'));
	assert.throws(() => speakPhonemes('?'), RangeError);
});

test('the voice is not muffled: a sung vowel keeps energy above 2 kHz', () => {
	const x = sing([{ phonemes: 'a', note: 57, duration: 1.2 }], { sampleRate: RATE, source: 'glottal', vibrato: 0 });
	// the energy of a sung vowel sits on the harmonics of its pitch (220 Hz): compare harmonics 1-4 with 10-22
	let low = 0;
	let high = 0;
	for (let k = 1; k <= 4; k++) low += bin(x, 220 * k) ** 2;
	for (let k = 10; k <= 22; k++) high += bin(x, 220 * k) ** 2;
	// the first version of the source measured about -35 dB on this kind of ratio, a natural open vowel is about -25 dB
	const ratio = 10 * Math.log10(high / low);
	assert.ok(ratio > -30, `ratio ${ratio.toFixed(1)} dB`);
});

test('vibrato moves the pitch slightly, a chorus has the length of one voice', () => {
	const plain = sing([{ phonemes: 'a', note: 57, duration: 1 }], { vibrato: 0 });
	const bent = sing([{ phonemes: 'a', note: 57, duration: 1 }], { vibrato: 0.01 });
	const choir = sing([{ phonemes: 'a', note: 57, duration: 1 }], { vibrato: 0, chorus: 3 });
	assert.notDeepEqual(plain, bent);
	assert.equal(choir.length, plain.length);
	assert.notDeepEqual(choir, plain);
});

test('a higher formant scale moves the energy up', () => {
	const man = speakPhonemes('a a a a', { sampleRate: RATE });
	const child = speakPhonemes('a a a a', { sampleRate: RATE, formantScale: 1.3 });
	// the second formant of /a/ is near 1300 Hz for the man and near 1690 Hz for the child
	assert.ok(bin(child, 1690) / bin(child, 1300) > bin(man, 1690) / bin(man, 1300));
});

/** strength of the pitch periodicity: the best normalised autocorrelation between 80 and 400 Hz */
function periodicity(x: Float32Array): number {
	const from = RATE >> 2;
	let e0 = 0;
	for (let i = from; i < x.length - 600; i++) e0 += x[i] * x[i];
	let best = 0;
	for (let lag = Math.floor(RATE / 400); lag <= Math.ceil(RATE / 80); lag++) {
		let dot = 0;
		let e1 = 0;
		for (let i = from; i < x.length - 600; i++) {
			dot += x[i] * x[i + lag];
			e1 += x[i + lag] * x[i + lag];
		}
		best = Math.max(best, dot / Math.sqrt(e0 * e1 + 1e-12));
	}
	return best;
}

test('word breaks add a pause between words and the last vowel of a word is held longer', () => {
	const run = speakPhonemes('a a');
	const words = speakPhonemes('a - a', { wordPause: 0.1 });
	// two words: a 0.1 s pause, and each final vowel lengthened by 30 % (the run of two vowels has only the last one)
	assert.ok(words.length > run.length + 0.09 * RATE);
	assert.ok(speakPhonemes('a - a', { wordPause: 0.2 }).length - words.length > 0.09 * RATE);
});

test('a whisper has no pitch and a breathy voice has less periodicity than a normal one', () => {
	// a flat pitch (no declination, no accent) so that only the phonation changes the periodicity
	const flat = { sampleRate: RATE, declination: 0, accent: 0, jitter: 0, pitch: 100 };
	const normal = speakPhonemes('a a a a a a', flat);
	const breathy = speakPhonemes('a a a a a a', { ...flat, breathiness: 1 });
	const whisper = speakPhonemes('a a a a a a', { ...flat, whisper: true });
	assert.ok(periodicity(normal) > 0.8, `normal ${periodicity(normal)}`);
	assert.ok(periodicity(breathy) < periodicity(normal));
	assert.ok(periodicity(whisper) < 0.4, `whisper ${periodicity(whisper)}`);
	assert.ok(whisper.some((s) => Math.abs(s) > 1e-3));
});

test('jitter keeps the pitch and removes the perfect regularity of a machine', () => {
	const steady = sing([{ phonemes: 'a', note: 57, duration: 1 }], { vibrato: 0, jitter: 0 });
	const human = sing([{ phonemes: 'a', note: 57, duration: 1 }], { vibrato: 0, jitter: 0.01 });
	assert.notDeepEqual(steady, human);
	assert.ok(periodicity(human) < periodicity(steady));
	assert.deepEqual(human, sing([{ phonemes: 'a', note: 57, duration: 1 }], { vibrato: 0, jitter: 0.01 }));
});

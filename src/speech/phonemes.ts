/** Acoustic target of a phoneme (formants after Peterson & Barney / Klatt tables, rounded) */
export interface Phoneme {
	formants: readonly [number, number, number];
	bandwidths: readonly [number, number, number];
	/** default duration in seconds */
	duration: number;
	voiced: boolean;
	/** noise amplitude 0..1 */
	noise: number;
	/** true for sounds that carry the pitch of a sung syllable */
	vowel: boolean;
}

const vowel = (f1: number, f2: number, f3: number, duration = 0.14): Phoneme => ({
	formants: [f1, f2, f3],
	bandwidths: [70, 100, 150],
	duration,
	voiced: true,
	noise: 0,
	vowel: true,
});

const fricative = (f2: number, f3: number, voiced: boolean, duration = 0.1): Phoneme => ({
	formants: [300, f2, f3],
	bandwidths: [200, 250, 300],
	duration,
	voiced,
	noise: 0.5,
	vowel: false,
});

const sonorant = (f1: number, f2: number, f3: number, duration = 0.07): Phoneme => ({
	formants: [f1, f2, f3],
	bandwidths: [80, 120, 200],
	duration,
	voiced: true,
	noise: 0,
	vowel: false,
});

const stop = (f2: number, f3: number, voiced: boolean): Phoneme => ({
	formants: [250, f2, f3],
	bandwidths: [150, 200, 300],
	duration: 0.06,
	voiced,
	noise: voiced ? 0.05 : 0.3,
	vowel: false,
});

/** Phoneme symbols are ASCII (SAMPA-like); `~` marks a nasal vowel, `_` a short pause */
export const PHONEMES: Readonly<Record<string, Phoneme>> = {
	a: vowel(750, 1300, 2500),
	A: vowel(730, 1100, 2450),
	e: vowel(400, 2100, 2700),
	E: vowel(580, 1800, 2600),
	i: vowel(280, 2250, 2900),
	o: vowel(450, 800, 2500),
	O: vowel(570, 900, 2500),
	u: vowel(310, 800, 2250),
	y: vowel(290, 1900, 2300),
	'2': vowel(400, 1500, 2400),
	'9': vowel(550, 1500, 2400),
	'@': vowel(500, 1400, 2500, 0.08),
	I: vowel(400, 1900, 2550),
	U: vowel(450, 1100, 2400),
	'{': vowel(660, 1700, 2450),
	V: vowel(640, 1200, 2400),
	'3': vowel(490, 1350, 1700),
	'a~': vowel(700, 1100, 2500, 0.16),
	'o~': vowel(450, 750, 2500, 0.16),
	'E~': vowel(560, 1700, 2500, 0.16),
	'9~': vowel(520, 1400, 2400, 0.16),
	j: sonorant(280, 2200, 2900),
	w: sonorant(300, 700, 2200),
	l: sonorant(360, 1300, 2700),
	r: sonorant(450, 1300, 1700),
	m: sonorant(250, 1000, 2200, 0.08),
	n: sonorant(250, 1500, 2500, 0.08),
	N: sonorant(250, 1900, 2500, 0.08),
	h: { ...fricative(1500, 2500, false, 0.07), noise: 0.25 },
	f: fricative(1200, 3500, false),
	v: fricative(1200, 3500, true),
	s: fricative(5000, 6500, false),
	z: fricative(5000, 6500, true),
	T: { ...fricative(1800, 3500, false, 0.09), noise: 0.3 },
	D: { ...fricative(1800, 3500, true, 0.06), noise: 0.2 },
	S: fricative(2500, 3500, false),
	Z: fricative(2500, 3500, true),
	p: stop(1000, 2300, false),
	b: stop(1000, 2300, true),
	t: stop(1800, 2800, false),
	d: stop(1800, 2800, true),
	k: stop(1600, 2500, false),
	g: stop(1600, 2500, true),
	/** a word break: a very short silence, so that the words do not run together */
	'-': {
		formants: [500, 1500, 2500],
		bandwidths: [100, 100, 100],
		duration: 0.04,
		voiced: false,
		noise: 0,
		vowel: false,
	},
	_: {
		formants: [500, 1500, 2500],
		bandwidths: [100, 100, 100],
		duration: 0.08,
		voiced: false,
		noise: 0,
		vowel: false,
	},
};

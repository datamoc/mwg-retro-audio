import { PHONEMES } from './phonemes.ts';

export type SpeechLanguage = 'fr' | 'en';

type Rule = readonly [RegExp, string];

const VOWELS = 'aeiouyàâäéèêëîïôöùûü';
const ACCENTS: Readonly<Record<string, string>> = {
	à: 'a',
	â: 'a',
	ä: 'a',
	é: 'e',
	è: 'E',
	ê: 'E',
	ë: 'E',
	î: 'i',
	ï: 'i',
	ô: 'o',
	ö: 'o',
	ù: 'y',
	û: 'y',
	ü: 'y',
	ç: 's',
};

/** Context free French rules, tried in order at the start of the rest of the word */
const FRENCH: readonly Rule[] = [
	[/^eau/, 'o'],
	[/^au/, 'o'],
	[/^ou/, 'u'],
	[/^oi/, 'w a'],
	[/^(ai|ei)/, 'E'],
	[/^(oeu|eu)/, '2'],
	[/^(ain|aim|ein)(?![aeiouyàâéèêîôùûnm])/, 'E~'],
	[/^(in|im)(?![aeiouyàâéèêîôùûnm])/, 'E~'],
	[/^(un|um)(?![aeiouyàâéèêîôùûnm])/, '9~'],
	[/^(on|om)(?![aeiouyàâéèêîôùûnm])/, 'o~'],
	[/^(an|am|en|em)(?![aeiouyàâéèêîôùûnm])/, 'a~'],
	[/^tion/, 's j o~'],
	[/^ch/, 'S'],
	[/^gn/, 'N'],
	[/^ph/, 'f'],
	[/^qu/, 'k'],
	[/^gu(?=[eiy])/, 'g'],
	[/^th/, 't'],
	[/^c(?=[eiy])/, 's'],
	[/^c/, 'k'],
	[/^g(?=[eiy])/, 'Z'],
	[/^g/, 'g'],
	[/^x/, 'k s'],
	[/^h/, ''],
	[/^j/, 'Z'],
	[/^w/, 'v'],
	[/^y/, 'i'],
	[/^e(?=[^aeiouyàâäéèêëîïôöùûü]{2}|[^aeiouyàâäéèêëîïôöùûü]$)/, 'E'],
	[/^e/, '@'],
	[/^u/, 'y'],
];

/** Context free English rules (a rough letter to sound set: the exceptions dictionary carries the common words) */
const ENGLISH: readonly Rule[] = [
	[/^th/, 's'],
	[/^sh/, 'S'],
	[/^ch/, 't S'],
	[/^ph/, 'f'],
	[/^ck/, 'k'],
	[/^qu/, 'k w'],
	[/^ng/, 'N'],
	[/^oo/, 'u'],
	[/^(ee|ea)/, 'i'],
	[/^(ai|ay)/, 'e'],
	[/^(ou|ow)/, 'a U'],
	[/^oa/, 'o'],
	[/^c(?=[eiy])/, 's'],
	[/^c/, 'k'],
	[/^g(?=[eiy])/, 'd Z'],
	[/^x/, 'k s'],
	[/^h/, 'h'],
	[/^j/, 'd Z'],
	[/^w/, 'w'],
	[/^a/, '{'],
	[/^e/, 'E'],
	[/^i/, 'I'],
	[/^o/, 'O'],
	[/^u/, 'V'],
];

const ENGLISH_WORDS: Readonly<Record<string, string>> = {
	the: 'd @',
	a: '@',
	to: 't u',
	of: 'V v',
	you: 'j u',
	one: 'w V n',
	i: 'a I',
	is: 'I z',
	and: '{ n d',
	we: 'w i',
	are: 'A r',
	my: 'm a I',
	hello: 'h E l o',
	world: 'w 3 l d',
};

/** French function words whose pronunciation the rules cannot tell from a plain unstressed e */
const FRENCH_WORDS: Readonly<Record<string, string>> = {
	les: 'l e',
	des: 'd e',
	mes: 'm e',
	tes: 't e',
	ses: 's e',
	ces: 's e',
	et: 'e',
	est: 'E',
	un: '9~',
};

const SINGLE: Readonly<Record<string, string>> = {
	a: 'a',
	b: 'b',
	d: 'd',
	f: 'f',
	i: 'i',
	k: 'k',
	l: 'l',
	m: 'm',
	n: 'n',
	o: 'o',
	p: 'p',
	r: 'r',
	t: 't',
	v: 'v',
	z: 'z',
	e: 'e',
	// the English fallbacks of the letters that the French rules do not cover
	s: 's',
	q: 'k',
	y: 'j',
};

function frenchWord(word: string, sung: boolean): string[] {
	const known = FRENCH_WORDS[word];
	if (known) return known.split(' ');
	let w = word.replace(/[àâäéèêëîïôöùûüç]/g, (c) =>
		c === 'é' || c === 'è' || c === 'ê' || c === 'ë' ? c : (ACCENTS[c] ?? c),
	);
	w = w.replace(/([bcdfgklmnprstvz])\1/g, '$1');
	// the mute e is not spoken, but it is sung: a syllable `que` or `se` keeps its vowel
	if (!sung && w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
	else if (!sung && w.length > 2 && w.endsWith('e')) w = w.slice(0, -1);
	if (w.length > 2) w = w.replace(/[stdxzp]$/, '');
	const out: string[] = [];
	let i = 0;
	while (i < w.length) {
		const rest = w.slice(i);
		const prev = w[i - 1] ?? '';
		const accent = ACCENTS[rest[0]];
		if (rest[0] === 'é') {
			out.push('e');
			i++;
			continue;
		}
		if (rest[0] === 'è' || rest[0] === 'ê' || rest[0] === 'ë') {
			out.push('E');
			i++;
			continue;
		}
		if (accent && rest[0] !== 'ç') {
			out.push(accent);
			i++;
			continue;
		}
		if (rest[0] === 's' && prev && VOWELS.includes(prev) && VOWELS.includes(rest[1] ?? '')) {
			out.push('z');
			i++;
			continue;
		}
		const rule = FRENCH.find(([re]) => re.test(rest));
		if (rule) {
			const m = rest.match(rule[0]) as RegExpMatchArray;
			if (rule[1]) out.push(...rule[1].split(' '));
			i += Math.max(1, m[0].length);
			continue;
		}
		const single = SINGLE[rest[0]];
		if (single) out.push(single);
		i++;
	}
	return out;
}

function englishWord(word: string): string[] {
	const known = ENGLISH_WORDS[word];
	if (known) return known.split(' ');
	let w = word;
	if (w.length > 3 && /[^aeiou]e$/.test(w)) w = w.slice(0, -1);
	const out: string[] = [];
	let i = 0;
	while (i < w.length) {
		const rest = w.slice(i);
		if (rest[0] === 'y') {
			out.push(i === 0 ? 'j' : 'i');
			i++;
			continue;
		}
		const rule = ENGLISH.find(([re]) => re.test(rest));
		if (rule) {
			const m = rest.match(rule[0]) as RegExpMatchArray;
			out.push(...rule[1].split(' '));
			i += m[0].length;
			continue;
		}
		const single = SINGLE[rest[0]];
		if (single) out.push(single);
		i++;
	}
	return out;
}

/**
 * Convert text to a phoneme string for `speakPhonemes` / `sing`. Words are converted by rules (French, with the usual
 * silent endings, nasals and liaison-free pronunciation) or by a short exception list plus rules (English, a rough
 * approximation). Punctuation that ends a clause becomes a pause. Unknown characters are ignored.
 */
export function textToPhonemes(
	text: string,
	language: SpeechLanguage = 'fr',
	options: { sung?: boolean; wordBreaks?: boolean } = {},
): string {
	const tokens: string[] = [];
	for (const part of text.toLowerCase().split(/([.,;:!?]+)|\s+|'|’/)) {
		if (!part) continue;
		if (/^[.,;:!?]+$/.test(part)) {
			tokens.push('_');
			continue;
		}
		const word = part.replace(/[^a-zàâäéèêëîïôöùûüç]/g, '');
		if (!word) continue;
		const last = tokens[tokens.length - 1];
		if (options.wordBreaks && last && last !== '_' && last !== '-') tokens.push('-');
		tokens.push(...(language === 'fr' ? frenchWord(word, options.sung ?? false) : englishWord(word)));
	}
	return tokens.filter((t) => t in PHONEMES).join(' ');
}

/** Split a phoneme string into syllables: each holds one vowel, a single consonant between vowels starts the next */
export function phonemesToSyllables(phonemes: string): string[] {
	const symbols = phonemes.split(/\s+/).filter(Boolean);
	const isVowel = (s: string): boolean => Boolean(PHONEMES[s]?.vowel);
	const syllables: string[][] = [];
	let current: string[] = [];
	let seenVowel = false;
	for (let i = 0; i < symbols.length; i++) {
		const s = symbols[i];
		if (s === '_' || s === '-') {
			if (current.length) syllables.push(current);
			current = [];
			seenVowel = false;
			continue;
		}
		if (isVowel(s)) {
			if (seenVowel) {
				syllables.push(current);
				current = [];
			}
			current.push(s);
			seenVowel = true;
			continue;
		}
		if (seenVowel) {
			// consonants after a vowel: look ahead, a cluster before the next vowel splits after its first consonant
			let j = i;
			while (j < symbols.length && !isVowel(symbols[j]) && symbols[j] !== '_') j++;
			const nextIsVowel = j < symbols.length && isVowel(symbols[j]);
			const cluster = j - i;
			if (nextIsVowel && cluster >= 2) {
				current.push(s);
				syllables.push(current);
				current = [];
				seenVowel = false;
				continue;
			}
			if (nextIsVowel) {
				syllables.push(current);
				current = [s];
				seenVowel = false;
				continue;
			}
		}
		current.push(s);
	}
	if (current.length) syllables.push(current);
	return syllables.map((syllable) => syllable.join(' '));
}

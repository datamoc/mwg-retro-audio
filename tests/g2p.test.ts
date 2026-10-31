import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHONEMES, phonemesToSyllables, singLyrics, singText, speakText, textToPhonemes } from '../src/speech/index.ts';

test('French words get their usual sounds', () => {
	assert.equal(textToPhonemes('bonjour'), 'b o~ Z u r');
	assert.equal(textToPhonemes('chat'), 'S a');
	assert.equal(textToPhonemes('eau'), 'o');
	assert.equal(textToPhonemes('maison'), 'm E z o~');
	assert.equal(textToPhonemes('je'), 'Z @');
	assert.equal(textToPhonemes('les'), 'l e');
	assert.equal(textToPhonemes('café'), 'k a f e');
});

test('punctuation makes a pause and the apostrophe splits words', () => {
	assert.equal(textToPhonemes('oui, non'), textToPhonemes('oui') + ' _ ' + textToPhonemes('non'));
	assert.equal(textToPhonemes("j'ai"), textToPhonemes('j ai'));
});

test('English falls back on a dictionary and rough rules', () => {
	assert.equal(textToPhonemes('the', 'en'), 'd @');
	assert.equal(textToPhonemes('you', 'en'), 'j u');
	assert.equal(textToPhonemes('ship', 'en'), 'S I p');
});

test('every phoneme produced is one the synthesizer knows', () => {
	const corpus = 'bonjour le monde, ceci est un petit texte français avec des liaisons, de la neige et du soleil !';
	for (const language of ['fr', 'en'] as const)
		for (const symbol of textToPhonemes(corpus, language).split(' ')) assert.ok(symbol in PHONEMES, symbol);
});

test('syllables hold one vowel each', () => {
	assert.deepEqual(phonemesToSyllables('b o~ Z u r'), ['b o~', 'Z u r']);
	assert.deepEqual(phonemesToSyllables('m a m a'), ['m a', 'm a']);
	assert.deepEqual(phonemesToSyllables('a r b r'), ['a r b r']);
});

test('text is spoken, and sung to a melody with the timing of the score', () => {
	const speech = speakText('bonjour', 'fr', { sampleRate: 22050 });
	assert.ok(speech.length > 22050 * 0.3 && speech.some((s) => Math.abs(s) > 0.01));
	const sung = singText(
		'bonjour',
		[
			{ note: 60, duration: 0.5 },
			{ note: 64, duration: 0.5 },
		],
		'fr',
		{ sampleRate: 22050 },
	);
	assert.ok(Math.abs(sung.length - 22050) <= 4);
});

test('sung French keeps the mute e that spoken French drops', () => {
	assert.equal(textToPhonemes('que', 'fr'), 'k');
	assert.equal(textToPhonemes('que', 'fr', { sung: true }), 'k @');
	assert.equal(textToPhonemes('se', 'fr', { sung: true }), 's @');
});

test('lyrics are sung one syllable per note, as text or explicit phonemes', () => {
	const notes = [
		{ note: 60, duration: 0.4 },
		{ note: 62, duration: 0.4 },
	];
	const sung = singLyrics(['ah', '/t w I n'], notes, 'fr', { sampleRate: 22050 });
	assert.ok(Math.abs(sung.length - 0.8 * 22050) <= 4);
	assert.throws(() => singLyrics(['ah'], notes), RangeError);
});

test('word breaks mark the limits of the words in the phonemes', () => {
	assert.equal(textToPhonemes('un deux', 'fr', { wordBreaks: true }), '9~ - d 2');
	assert.equal(
		textToPhonemes('oui, non', 'fr', { wordBreaks: true }),
		textToPhonemes('oui', 'fr') + ' _ ' + textToPhonemes('non', 'fr'),
	);
	assert.deepEqual(phonemesToSyllables('b o~ - Z u r'), ['b o~', 'Z u r']);
});

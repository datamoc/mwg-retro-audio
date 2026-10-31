// Traditional nursery rhymes for the a cappella demos (public domain): the French song "Ah ! vous dirai-je, maman"
// (1774 words) and its English version "Twinkle, Twinkle, Little Star" (1806 words) share one melody.
import type { MelodyNote } from '../src/speech/index.ts';

const C4 = 60;
const D4 = 62;
const E4 = 64;
const F4 = 65;
const G4 = 67;
const A4 = 69;

/** six phrases of seven notes: six quarter notes then a half note, in 4/4 */
const PHRASES: readonly (readonly number[])[] = [
	[C4, C4, G4, G4, A4, A4, G4],
	[F4, F4, E4, E4, D4, D4, C4],
	[G4, G4, F4, F4, E4, E4, D4],
	[G4, G4, F4, F4, E4, E4, D4],
	[C4, C4, G4, G4, A4, A4, G4],
	[F4, F4, E4, E4, D4, D4, C4],
];

/** the melody at `bpm`: quarter notes, the last note of each phrase a half note (a little longer at the very end) */
export function melody(bpm: number): MelodyNote[] {
	const beat = 60 / bpm;
	return PHRASES.flatMap((phrase, p) =>
		phrase.map((note, i) => ({
			note,
			duration: i < 6 ? beat : p === PHRASES.length - 1 ? 3 * beat : 2 * beat,
		})),
	);
}

/** French, one syllable per note (the mute e is sung) */
export const FRENCH_SYLLABLES = [
	...['ah', 'vous', 'di', 'rai', 'je', 'ma', 'man'],
	...['ce', 'qui', 'cau', 'se', 'mon', 'tour', 'ment'],
	...['pa', 'pa', 'veut', 'que', 'je', 'rai', 'son'],
	...['kom', 'mu', 'ne', 'gran', 'de', 'per', 'son'],
	...['moi', 'je', 'dis', 'que', 'les', 'bon', 'bons'],
	...['va', 'lent', 'mieu', 'que', 'les', 'le', 'çons'],
];

/** English, as explicit phonemes (a slash starts them): spelling is no guide for English */
export const ENGLISH_SYLLABLES = [
	...['/t w I n', '/k @ l', '/t w I n', '/k @ l', '/l I t', '/t @ l', '/s t A r'],
	...['/h a U', '/a I', '/w V n', '/d 3', '/w V t', '/j u', '/A r'],
	...['/V p', '/@', '/b V v', '/D @', '/w 3 l d', '/s o', '/h a I'],
	...['/l a I k', '/@', '/d a I', '/m @ n d', '/I n', '/D @', '/s k a I'],
	...['/t w I n', '/k @ l', '/t w I n', '/k @ l', '/l I t', '/t @ l', '/s t A r'],
	...['/h a U', '/a I', '/w V n', '/d 3', '/w V t', '/j u', '/A r'],
];

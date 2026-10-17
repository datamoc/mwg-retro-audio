import type { Lang } from './i18n.ts';
import meditation from './music/Meditation.mid';
import ancientMysteries from './music/ancient-mysteries.mid';
import beethoven5 from './music/beethoven-5-1.mid';
import beethoven7 from './music/beethoven-7-2.mid';
import gymnopedie from './music/gymnopedie-1.mid';
import sauvages from './music/les-sauvages.mid';
import marcheTurque from './music/marche-turque.mid';
import themeSong from './music/theme-song.mid';

/** MIDI files bundled into the page (from the pontifex game assets), for the autoplay mode */
export const songs: readonly { title: Record<Lang, string>; bytes: Uint8Array }[] = [
	{ title: { fr: 'Theme song', en: 'Theme song', de: 'Theme song' }, bytes: themeSong },
	{
		title: { fr: 'Mozart — Marche turque', en: 'Mozart — Turkish March', de: 'Mozart — Türkischer Marsch' },
		bytes: marcheTurque,
	},
	{
		title: { fr: 'Rameau — Les Sauvages', en: 'Rameau — Les Sauvages', de: 'Rameau — Les Sauvages' },
		bytes: sauvages,
	},
	{
		title: {
			fr: 'Beethoven — Symphonie n°5, 1er mouvement',
			en: 'Beethoven — Symphony No. 5, 1st movement',
			de: 'Beethoven — Sinfonie Nr. 5, 1. Satz',
		},
		bytes: beethoven5,
	},
	{
		title: {
			fr: 'Beethoven — Symphonie n°7, 2e mouvement',
			en: 'Beethoven — Symphony No. 7, 2nd movement',
			de: 'Beethoven — Sinfonie Nr. 7, 2. Satz',
		},
		bytes: beethoven7,
	},
	{
		title: {
			fr: 'Massenet — Méditation de Thaïs',
			en: 'Massenet — Meditation from Thaïs',
			de: 'Massenet — Méditation aus Thaïs',
		},
		bytes: meditation,
	},
	{ title: { fr: 'Ancient mysteries', en: 'Ancient mysteries', de: 'Ancient mysteries' }, bytes: ancientMysteries },
	{
		title: { fr: 'Satie — Gymnopédie n°1', en: 'Satie — Gymnopédie No. 1', de: 'Satie — Gymnopédie Nr. 1' },
		bytes: gymnopedie,
	},
];

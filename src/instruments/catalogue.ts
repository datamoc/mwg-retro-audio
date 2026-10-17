import type { InstrumentDef } from './Instrument.ts';
import { psgInstruments } from './psg.ts';
import { historicalInstruments } from './synths.ts';
import { modelledInstruments } from './modelled.ts';
import { registerInstruments } from './registers.ts';
import { oplInstruments, opmInstruments, opnInstruments } from './fm-registers.ts';
import { pcInstruments } from './pc-registers.ts';
import { SimpleInstrument, piano, electricPiano, organ, guitar, bass, strings, brass, flute, synth } from './simple.ts';

/** Explicit full UI catalogue. Import targeted factories instead when a selection UI is not needed. */
export const instrumentCatalogue: readonly InstrumentDef[] = [
	...[piano, electricPiano, organ, guitar, bass, strings, brass, flute, synth].map(
		(profile) =>
			({
				info: {
					id: `simple:${profile.name}`,
					name: profile.name,
					family: 'synth' as const,
					era: 'Modern',
					description: 'Additive profile',
					polyphony: 16,
				},
				create: (options) => new SimpleInstrument(profile, options),
			}) satisfies InstrumentDef,
	),
	...psgInstruments,
	...historicalInstruments,
	...modelledInstruments,
	...registerInstruments,
	...oplInstruments,
	...opnInstruments,
	...opmInstruments,
	...pcInstruments,
];

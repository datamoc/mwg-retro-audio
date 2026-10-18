import type { InstrumentDef } from './Instrument.ts';
import { SimpleInstrument, piano, electricPiano, organ, guitar, bass, strings, brass, flute, synth } from './simple.ts';

/** the plain additive profiles as catalogue entries, `simple:<name>` */
export const simpleInstruments: readonly InstrumentDef[] = [
	piano,
	electricPiano,
	organ,
	guitar,
	bass,
	strings,
	brass,
	flute,
	synth,
].map(
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
);

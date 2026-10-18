import type { InstrumentDef } from './Instrument.ts';
import { psgInstruments } from './psg.ts';
import { historicalInstruments } from './synths.ts';
import { modelledInstruments } from './modelled.ts';
import { registerInstruments } from './registers.ts';
import { oplInstruments, opmInstruments, opnInstruments } from './fm-registers.ts';
import { pcInstruments } from './pc-registers.ts';
import { simpleInstruments } from './simpleCatalogue.ts';

/** Explicit full UI catalogue. Import targeted factories instead when a selection UI is not needed. */
export const instrumentCatalogue: readonly InstrumentDef[] = [
	...simpleInstruments,
	...psgInstruments,
	...historicalInstruments,
	...modelledInstruments,
	...registerInstruments,
	...oplInstruments,
	...opnInstruments,
	...opmInstruments,
	...pcInstruments,
];

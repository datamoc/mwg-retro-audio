import type { MidiSynthFactory } from '@datamoc/mw_games/audio';
import { instrumentCatalogue } from '../instruments/catalogue.ts';
import { instrumentMidiEngines } from './instrumentEngines.ts';
import { retroMidiEngines } from './midiEngines.ts';

/**
 * Every model of the catalogue as a named MIDI engine (`retro:<id>`), the dedicated `retro:mt32`, `retro:dx7` and
 * `retro:d50` keeping their own implementations (they read SysEx). This module imports the whole catalogue: import it
 * only when every model is wanted, and use `instrumentMidiEngines` from the `mwg` entry point for a chosen few.
 */
export const retroCatalogueMidiEngines: Readonly<Record<string, MidiSynthFactory>> = Object.freeze({
	...instrumentMidiEngines(instrumentCatalogue),
	...retroMidiEngines,
});

/** registers them with mwg's `registerMidiSynth`; returns the names */
export function registerRetroCatalogueMidiEngines(
	register: (name: string, factory: MidiSynthFactory) => void,
): string[] {
	for (const [name, factory] of Object.entries(retroCatalogueMidiEngines)) register(name, factory);
	return Object.keys(retroCatalogueMidiEngines);
}

/** the mirror of {@link registerRetroCatalogueMidiEngines}, over `unregisterMidiSynth` */
export function unregisterRetroCatalogueMidiEngines(unregister: (name: string) => boolean): string[] {
	return Object.keys(retroCatalogueMidiEngines).filter((name) => unregister(name));
}

import type { Instrument, InstrumentDef, InstrumentInfo, InstrumentOptions } from './Instrument.ts';

const defs = new Map<string, InstrumentDef>();

/** register (or replace) an instrument */
export function registerInstrument(def: InstrumentDef): void {
	defs.set(def.info.id, def);
}

/** create an instrument by id; throws for an unknown id */
export function createInstrument(id: string, options: InstrumentOptions = {}): Instrument {
	const def = defs.get(id);
	if (!def) throw new Error(`unknown instrument '${id}' (known: ${[...defs.keys()].join(', ')})`);
	return def.create(options);
}

/** ids of all registered instruments, in registration order */
export function instrumentIds(): string[] {
	return [...defs.keys()];
}

/** the descriptions of all registered instruments, in registration order */
export function instrumentInfos(): InstrumentInfo[] {
	return [...defs.values()].map((d) => d.info);
}

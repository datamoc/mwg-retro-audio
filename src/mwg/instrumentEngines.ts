import type { MidiSynth, MidiSynthFactory } from '@datamoc/mwg/audio';
import { InstrumentMidiSink } from '../instruments/InstrumentMidiSink.ts';
import type { Instrument, InstrumentDef } from '../instruments/Instrument.ts';

/**
 * Any instrument of the catalogue as an mwg `MidiSynth`: the channels are merged into the one sound of the instrument,
 * percussion is left out and, when the instrument has fewer voices than the song, the notes are thinned the way
 * `InstrumentMidiSink` does (melody and bass kept). Pitch bend (a range of two semitones) and the sustain pedal are
 * passed on; program changes and system-exclusive messages are ignored, the sound of a model is its controls.
 */
export class InstrumentMidiSynth implements MidiSynth {
	readonly sampleRate: number;
	private readonly instrument: Instrument;
	private readonly sink: InstrumentMidiSink;

	constructor(definition: InstrumentDef, sampleRate = 44100) {
		this.sampleRate = sampleRate;
		this.instrument = definition.create({ sampleRate });
		this.sink = new InstrumentMidiSink(this.instrument);
	}

	event(status: number, data1: number, data2: number): void {
		const kind = status & 0xf0;
		if (kind === 0xe0) this.instrument.pitchBend((((data2 << 7) | data1) - 8192) / 4096);
		else if (kind === 0xb0 && data1 === 64) this.instrument.sustain(data2 >= 64);
		else this.sink.event(status, data1, data2);
	}

	sysex(): void {}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.instrument.render(left, right, start, count);
	}

	reset(): void {
		this.sink.silence();
		this.instrument.reset();
	}
}

/** the engine name of a catalogue id: `retro:ym2149`, `retro:simple:electric-piano` (lower case, spaces as hyphens) */
export function instrumentEngineName(id: string): string {
	return `retro:${id.toLowerCase().replace(/\s+/g, '-')}`;
}

/** engines for the given instruments, by name; the caller picks the definitions, so nothing is pulled in unasked */
export function instrumentMidiEngines(definitions: readonly InstrumentDef[]): Record<string, MidiSynthFactory> {
	const engines: Record<string, MidiSynthFactory> = {};
	for (const definition of definitions)
		engines[instrumentEngineName(definition.info.id)] = (sampleRate) =>
			new InstrumentMidiSynth(definition, sampleRate);
	return engines;
}

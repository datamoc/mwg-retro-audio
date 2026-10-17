import type { Chip } from '../chips/Chip.ts';

/**
 * Layer 2b - an instrument: a chip or a synthesiser that can be played by notes and tuned by named settings.
 *
 * The chips of `src/chips` are driven by registers, like the hardware. An `Instrument` is the musician's view of the
 * same thing: `noteOn` / `noteOff` with a MIDI note number, and a list of **controls** (the settings that matter for
 * that generator, described as data) that a user interface can show without knowing anything about the chip. The
 * controls change from one generator to the next: a YM2149 has a mixer and a hardware envelope, an OPL2 has operators,
 * a D-50 has partials and structures.
 */

export type InstrumentFamily =
	| 'psg' // programmable sound generators: square waves and noise (AY, SN76489, SAA1099...)
	| 'console' // the sound chips of game consoles (NES, VRC6, FDS...)
	| 'sid' // MOS 6581 / 8580
	| 'fm' // frequency modulation chips (OPL, OPN, OPM)
	| 'speaker' // one bit speakers
	| 'sampler' // sample based
	| 'card' // PC sound cards
	| 'synth'; // modelled synthesisers

export interface InstrumentInfo {
	/** registry id: the chip id when the instrument is a chip ('ym2149'), a short name otherwise */
	id: string;
	name: string;
	family: InstrumentFamily;
	/** years of production, informative: '1978-1985' */
	era: string;
	/** one or two sentences: what it is and what its controls do */
	description: string;
	/** how many notes can sound at once */
	polyphony: number;
	/** false for generators with no usable pitch (noise only): the automatic pitch check skips them */
	pitched?: boolean;
	/** how far, in cents, a note may be from its target pitch (a 1 bit speaker or a 10 bit period quantises) */
	pitchTolerance?: number;
}

export interface ControlBase {
	/** stable identifier, unique inside an instrument */
	id: string;
	label: string;
	/** section of the panel the control belongs to ('Oscillator', 'Filter', 'Envelope'...) */
	group?: string;
	/** a short explanation, shown as a tooltip */
	hint?: string;
}

export interface RangeControl extends ControlBase {
	kind: 'range';
	min: number;
	max: number;
	step: number;
	unit?: string;
	/** how a slider should map its travel to the value (default linear) */
	scale?: 'linear' | 'log';
	defaultValue: number;
	get(): number;
	set(value: number): void;
}

export interface ChoiceOption {
	value: number;
	label: string;
}

export interface ChoiceControl extends ControlBase {
	kind: 'choice';
	options: readonly ChoiceOption[];
	defaultValue: number;
	get(): number;
	set(value: number): void;
}

export interface ToggleControl extends ControlBase {
	kind: 'toggle';
	defaultValue: boolean;
	get(): boolean;
	set(value: boolean): void;
}

export type Control = RangeControl | ChoiceControl | ToggleControl;

export interface InstrumentPreset {
	name: string;
	/** put the instrument in this state: sets controls, loads a patch... */
	apply(): void;
}

export interface Instrument {
	readonly info: InstrumentInfo;
	readonly sampleRate: number;
	/** the chip or synthesiser underneath, for inspection (channel muting, metering) */
	readonly chip: Chip;
	/** the settings, in display order. The list may change when a control is set (`onChange` is then called) */
	readonly controls: readonly Control[];
	readonly presets: readonly InstrumentPreset[];
	/** set by the user interface: called when controls or their values changed by themselves (a preset, linked settings) */
	onChange: (() => void) | null;

	/** start a note (MIDI number 0-127, velocity 1-127; velocity 0 is a note off) */
	noteOn(note: number, velocity?: number): void;
	noteOff(note: number): void;
	allNotesOff(): void;
	/** pitch bend in semitones (positive = up), applied to the notes now sounding and to the next ones */
	pitchBend(semitones: number): void;
	/** sustain pedal: while it is down, note offs are held back */
	sustain(down: boolean): void;
	/** how many notes are sounding now */
	readonly activeNotes: number;
	applyPreset(index: number): void;
	/** ADD `count` stereo frames into the buffers, as `Chip.render` does */
	render(left: Float32Array, right: Float32Array, start: number, count: number): void;
	/** silence everything and return the chip to its power-on state, controls to their defaults */
	reset(): void;
}

/** the registry entry of an instrument */
export interface InstrumentDef {
	info: InstrumentInfo;
	create(options: InstrumentOptions): Instrument;
}

export interface InstrumentOptions {
	/** output sample rate in Hz (default 44100) */
	sampleRate?: number;
}

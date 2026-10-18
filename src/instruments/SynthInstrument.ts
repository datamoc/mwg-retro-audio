import type { Chip } from '../chips/Chip.ts';
import { BaseInstrument } from './BaseInstrument.ts';
import type { InstrumentDef, InstrumentInfo, InstrumentOptions, RangeControl } from './Instrument.ts';
import { choiceControl, labelled, param } from './controls.ts';
export interface NoteChip extends Chip {
	noteOn(note: number, velocity?: number): void;
	noteOff(note: number): void;
}

/** Shared note lifecycle for synths that already implement polyphonic notes. */
export class SynthInstrument<T extends NoteChip> extends BaseInstrument {
	private readonly velocities = new Map<number, number>();
	constructor(
		readonly info: InstrumentInfo,
		readonly chip: T,
		private readonly configure: (instrument: SynthInstrument<T>) => void,
		options: InstrumentOptions,
	) {
		super(options);
		configure(this);
	}
	protected press(note: number, velocity: number): void {
		if (!this.velocities.has(note) && this.velocities.size >= this.info.polyphony) {
			const oldest = this.velocities.keys().next().value!;
			this.lift(oldest);
			this.forgetNote(oldest);
		}
		this.chip.noteOff(note);
		this.velocities.delete(note);
		this.velocities.set(note, velocity);
		this.chip.noteOn(note + this.bend, velocity);
	}
	protected lift(note: number): void {
		this.chip.noteOff(note + this.bend);
		this.velocities.delete(note);
	}
	protected override retune(): void {
		// These engines identify voices by note number; do not retrigger envelopes to fake a continuous bend.
	}
	override pitchBend(_semitones: number): void {}
	override reset(): void {
		this.velocities.clear();
		super.reset();
		this.controls = [];
		this.configure(this);
		this.onChange?.();
	}
	/** A bounded, typed setting with the actual model value as its default. */
	number(
		id: string,
		label: string,
		min: number,
		max: number,
		step: number,
		get: () => number,
		set: (value: number) => void,
		unit?: string,
	): void {
		const control: RangeControl = {
			id,
			label,
			kind: 'range',
			min,
			max,
			step,
			unit,
			defaultValue: get(),
			get,
			set(value) {
				if (!Number.isFinite(value)) return;
				set(Math.max(min, Math.min(max, min + Math.round((value - min) / step) * step)));
			},
		};
		this.controls.push(control);
	}
	presetChoice(names: readonly string[], select: (index: number) => void): void {
		const index = param(0);
		const choose = (value: number): void => {
			this.controls = [control];
			select(value);
			this.onChange?.();
		};
		const control = choiceControl({ id: 'preset', label: 'Preset' }, labelled(names), index, choose);
		this.controls.push(control);
		this.presets = names.map((name, value) => ({ name, apply: () => control.set(value) }));
		choose(0);
	}
}

export function definition<T extends NoteChip>(
	id: string,
	name: string,
	era: string,
	polyphony: number,
	create: (options: InstrumentOptions) => T,
	configure: (instrument: SynthInstrument<T>) => void,
	/** what differs from the common description: another family, a description of its own */
	extra: Partial<InstrumentInfo> = {},
): InstrumentDef {
	const info: InstrumentInfo = {
		id,
		name,
		era,
		polyphony,
		family: 'synth',
		description:
			'Modèle de synthèse sans ROM. Les réglages modifient le moteur choisi ; les presets sont des reconstructions. Pitch bend continu non pris en charge par cet adaptateur.',
		...extra,
	};
	return { info, create: (options) => new SynthInstrument(info, create(options), configure, options) };
}

import type { Chip } from '../chips/Chip.ts';
import type { Control, Instrument, InstrumentInfo, InstrumentOptions, InstrumentPreset } from './Instrument.ts';

/**
 * Common behaviour of the instruments: note bookkeeping (velocity 0 as note off, the sustain pedal, pitch bend),
 * rendering through the chip, presets and the change notification. A subclass says what a note does to the chip.
 */
export abstract class BaseInstrument implements Instrument {
	abstract readonly info: InstrumentInfo;
	abstract readonly chip: Chip;
	readonly sampleRate: number;
	controls: Control[] = [];
	presets: InstrumentPreset[] = [];
	onChange: (() => void) | null = null;
	/** pitch bend in semitones */
	protected bend = 0;
	/** vibrato offset in cents, set by the subclass that has a vibrato */
	protected lfoCents = 0;
	protected pedal = false;
	private readonly held = new Set<number>();
	private readonly pending = new Set<number>();

	constructor(options: InstrumentOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
	}

	/** start sounding `note` */
	protected abstract press(note: number, velocity: number): void;
	/** stop sounding `note` (its release phase starts) */
	protected abstract lift(note: number): void;
	/** set the chip up after a reset, once the controls are back at their defaults (write the mixer, load a default patch) */
	protected restore(): void {}
	/** a pitch bend changed: retune the notes now sounding */
	protected retune(): void {}

	/** a preset that sets the named controls (every other control goes back to its default first) */
	protected preset(name: string, values: Record<string, number | boolean>): InstrumentPreset {
		return {
			name,
			apply: () => {
				for (const c of this.controls) {
					const v = c.id in values ? values[c.id] : c.defaultValue;
					(c as { set(v: number | boolean): void }).set(v);
				}
			},
		};
	}

	/** frequency of a MIDI note with the current bend */
	protected hz(note: number): number {
		return 440 * 2 ** ((note + this.bend + this.lfoCents / 100 - 69) / 12);
	}

	protected changed(): void {
		this.onChange?.();
	}

	/** Forget a note whose hardware voice was stolen, including a deferred pedal release. */
	protected forgetNote(note: number): void {
		this.held.delete(note);
		this.pending.delete(note);
	}

	get activeNotes(): number {
		return this.held.size;
	}

	noteOn(note: number, velocity = 100): void {
		if (velocity <= 0) return this.noteOff(note);
		this.pending.delete(note);
		this.held.add(note);
		this.press(note, Math.min(127, velocity));
	}

	noteOff(note: number): void {
		if (!this.held.has(note)) return;
		if (this.pedal) {
			this.pending.add(note);
			return;
		}
		this.pending.delete(note);
		this.held.delete(note);
		this.lift(note);
	}

	allNotesOff(): void {
		this.pedal = false;
		for (const n of [...this.held]) {
			this.held.delete(n);
			this.pending.delete(n);
			this.lift(n);
		}
	}

	sustain(down: boolean): void {
		this.pedal = down;
		if (down) return;
		for (const n of [...this.pending]) {
			this.pending.delete(n);
			this.held.delete(n);
			this.lift(n);
		}
	}

	pitchBend(semitones: number): void {
		this.bend = semitones;
		this.retune();
	}

	applyPreset(index: number): void {
		this.presets[index]?.apply();
		this.changed();
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.chip.render(left, right, start, count);
	}

	reset(): void {
		this.held.clear();
		this.pending.clear();
		this.pedal = false;
		this.bend = 0;
		this.lfoCents = 0;
		this.chip.reset();
		for (const c of this.controls) (c as { set(v: number | boolean): void }).set(c.defaultValue);
		this.restore();
		this.changed();
	}
}

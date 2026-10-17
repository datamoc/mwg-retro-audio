import type { Chip } from '../chips/Chip.ts';
import type { MidiSink } from '../formats/midi.ts';
import type { Instrument } from './Instrument.ts';

/**
 * Plays MIDI messages on an `Instrument`, so that a `MidiPlayer` can drive any generator of the catalogue.
 *
 * All the channels are merged into the one sound of the instrument (program changes are ignored) and the percussion
 * channel is left out: a chip has no drum kit. A song written for sixteen channels does not fit a chip with three
 * voices, so when the instrument is full the notes are thinned the way a tracker musician arranges them for a PSG:
 * the highest note (the melody) always stays, the lowest one (the bass) stays when there are two voices or more, and
 * the oldest of the others gives way.
 */
export class InstrumentMidiSink implements MidiSink {
	/** stands for the instrument's chip: `MidiPlayer` renders it, and this renders the instrument (envelopes included) */
	readonly chip: Chip;
	/** (channel, note) pairs sounding now, with the order in which they started */
	private readonly sounding = new Map<number, { note: number; age: number }>();
	private age = 0;

	constructor(private readonly instrument: Instrument) {
		const base = instrument.chip;
		this.chip = {
			id: base.id,
			name: base.name,
			channels: base.channels,
			clock: base.clock,
			sampleRate: base.sampleRate,
			reset: () => this.silence(),
			write: (addr, value) => base.write(addr, value),
			read: (addr) => base.read(addr),
			render: (left, right, start, count) => instrument.render(left, right, start, count),
			setMuted: (channel, muted) => base.setMuted(channel, muted),
		};
	}

	event(status: number, data1: number, data2: number): void {
		const kind = status & 0xf0;
		const channel = status & 15;
		if (kind === 0xb0 && (data1 === 120 || data1 === 123)) this.silence();
		else if (channel === 9) return;
		else if (kind === 0x90 && data2 > 0) this.noteOn(channel, data1, data2);
		else if (kind === 0x80 || kind === 0x90) this.noteOff(channel, data1);
	}

	/** release every note and forget them: the song restarts, or loops */
	silence(): void {
		this.sounding.clear();
		this.instrument.allNotesOff();
	}

	private pitchSounds(note: number): boolean {
		for (const value of this.sounding.values()) if (value.note === note) return true;
		return false;
	}

	private noteOn(channel: number, note: number, velocity: number): void {
		const key = channel * 128 + note;
		if (this.sounding.has(key)) return;
		const entry = { note, age: ++this.age };
		if (this.pitchSounds(note)) {
			this.sounding.set(key, entry);
			return;
		}
		const pitches = new Map<number, number>();
		for (const value of this.sounding.values()) pitches.set(value.note, value.age);
		const voices = this.instrument.info.polyphony;
		if (pitches.size >= voices) {
			pitches.set(note, entry.age);
			const sorted = [...pitches.keys()].sort((a, b) => a - b);
			const kept = new Set([sorted[sorted.length - 1]]);
			if (voices >= 2) kept.add(sorted[0]);
			let victim = -1;
			for (const [pitch, age] of pitches) {
				if (!kept.has(pitch) && (victim < 0 || age < pitches.get(victim)!)) victim = pitch;
			}
			if (victim === note) return;
			this.instrument.noteOff(victim);
			for (const [other, value] of this.sounding) if (value.note === victim) this.sounding.delete(other);
		}
		this.sounding.set(key, entry);
		this.instrument.noteOn(note, velocity);
	}

	private noteOff(channel: number, note: number): void {
		if (!this.sounding.delete(channel * 128 + note)) return;
		if (!this.pitchSounds(note)) this.instrument.noteOff(note);
	}
}

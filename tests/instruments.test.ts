import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historicalInstruments } from '../src/instruments/synths.ts';
import { modelledInstruments } from '../src/instruments/modelled.ts';
import { registerInstruments } from '../src/instruments/registers.ts';
import { oplInstruments, opnInstruments, opmInstruments } from '../src/instruments/fm-registers.ts';
import { pcInstruments } from '../src/instruments/pc-registers.ts';
import type { Instrument } from '../src/instruments/Instrument.ts';

const playable = [
	...historicalInstruments,
	...modelledInstruments,
	...registerInstruments,
	...oplInstruments,
	...opnInstruments,
	...opmInstruments,
	...pcInstruments,
];

function sound(instrument: Instrument, seconds = 0.4): Float32Array {
	const left = new Float32Array(Math.round(instrument.sampleRate * seconds));
	instrument.render(left, new Float32Array(left.length), 0, left.length);
	assert(left.every(Number.isFinite), instrument.info.id);
	return left;
}

test('every instrument and each exposed preset produce real finite audio', () => {
	for (const definition of playable) {
		const instrument = definition.create({ sampleRate: 16000 });
		for (let index = 0; index < Math.max(1, instrument.presets.length); index++) {
			instrument.reset();
			if (instrument.presets.length) instrument.applyPreset(index);
			instrument.noteOn(60, 100);
			assert(
				sound(instrument).some((value) => Math.abs(value) > 1e-5),
				`${definition.info.id} preset ${index}`,
			);
			instrument.noteOff(60);
			assert.equal(instrument.activeNotes, 0);
			for (const control of instrument.controls) {
				if (control.kind === 'range') {
					assert(Number.isFinite(control.get()), control.id);
					assert(control.get() >= control.min && control.get() <= control.max, control.id);
				}
			}
		}
	}
});

test('presets are isolated between instruments; defaults and silence can be restored', () => {
	for (const definition of playable) {
		const first = definition.create({ sampleRate: 16000 });
		const second = definition.create({ sampleRate: 16000 });
		const before = second.controls.map((control) => control.get());
		for (const control of [...first.controls]) {
			if (control.kind !== 'range') continue;
			control.set(control.max);
			assert.equal(control.get(), control.max);
		}
		assert.deepEqual(
			second.controls.map((control) => control.get()),
			before,
		);
		first.noteOn(60);
		first.sustain(true);
		first.noteOff(60);
		first.reset();
		assert.equal(first.activeNotes, 0);
		assert(
			sound(first, 0.1).every((value) => value === 0),
			definition.info.id,
		);
		assert.deepEqual(
			first.controls.map((control) => control.get()),
			before,
		);
	}
});

test('register instruments steal old notes without leaving deferred pedal releases', () => {
	for (const definition of registerInstruments) {
		const instrument = definition.create({ sampleRate: 16000 });
		instrument.sustain(true);
		for (let index = 0; index < instrument.info.polyphony + 5; index++) {
			instrument.noteOn(60 + index);
			instrument.noteOff(60 + index);
		}
		assert.equal(instrument.activeNotes, instrument.info.polyphony, definition.info.id);
		instrument.sustain(false);
		assert.equal(instrument.activeNotes, 0);
		assert(sound(instrument).every(Number.isFinite));
	}
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	SimpleInstrument,
	organ,
	piano,
	electricPiano,
	guitar,
	bass,
	strings,
	brass,
	flute,
	synth,
} from '../src/instruments/simple.ts';

function render(instrument: SimpleInstrument, seconds: number): Float32Array {
	const left = new Float32Array(Math.round(instrument.sampleRate * seconds));
	instrument.render(left, new Float32Array(left.length), 0, left.length);
	return left;
}

test('simple profiles produce finite audio and finish timed chords without wall-clock timers', () => {
	for (const profile of [piano, electricPiano, organ, guitar, bass, strings, brass, flute, synth]) {
		const instrument = new SimpleInstrument(profile, { sampleRate: 8000 });
		instrument.play([60, 64, 67], 0.3);
		const audio = render(instrument, 0.3 + profile.release + 0.05);
		assert(audio.every(Number.isFinite));
		assert(
			audio.some((v) => Math.abs(v) > 0.0001),
			profile.name,
		);
		assert(
			audio.slice(-100).every((v) => v === 0),
			profile.name,
		);
		assert.equal(instrument.activeNotes, 0);
	}
});

test('sustain counts each note once; retrigger cancels pending release and panic clears pedal', () => {
	const instrument = new SimpleInstrument(organ, { sampleRate: 8000 });
	instrument.noteOn(60);
	instrument.sustain(true);
	instrument.noteOff(60);
	assert.equal(instrument.activeNotes, 1);
	instrument.noteOn(60);
	instrument.sustain(false);
	assert.equal(instrument.activeNotes, 1);
	instrument.sustain(true);
	instrument.allNotesOff();
	instrument.noteOn(64);
	instrument.noteOff(64);
	assert.equal(instrument.activeNotes, 0);
	assert(
		render(instrument, 0.1)
			.slice(-100)
			.every((v) => v === 0),
	);
});

test('custom profiles, velocity, volume, muting and additive render work', () => {
	const instrument = new SimpleInstrument({ ...organ, name: 'Sine', harmonics: [1] }, { sampleRate: 8000 });
	instrument.play(69);
	const audio = render(instrument, 1);
	let crossings = 0;
	for (let i = 801; i < 7200; i++) if (audio[i - 1] <= 0 && audio[i] > 0) crossings++;
	assert(Math.abs(crossings / 0.8 - 440) < 2);
	const volume = instrument.controls.find((control) => control.id === 'volume');
	assert(volume?.kind === 'range');
	volume.set(0);
	const left = new Float32Array(100).fill(0.1);
	instrument.render(left, new Float32Array(100), 0, 100);
	assert(left.every((v) => v === Math.fround(0.1)));
	instrument.reset();
	assert.equal(instrument.activeNotes, 0);
	assert.throws(() => instrument.noteOn(NaN), RangeError);
	assert.equal(instrument.activeNotes, 0);
	assert.throws(() => instrument.play(60, -1), RangeError);
});

test('voice stealing under sustain leaves no ghost notes', () => {
	const instrument = new SimpleInstrument(organ, { sampleRate: 8000 }, 2);
	instrument.sustain(true);
	instrument.noteOn(60);
	instrument.noteOff(60);
	instrument.noteOn(64);
	instrument.noteOn(67);
	assert.equal(instrument.activeNotes, 2);
	instrument.sustain(false);
	instrument.allNotesOff();
	assert.equal(instrument.activeNotes, 0);
	assert(
		render(instrument, 0.1)
			.slice(-100)
			.every((v) => v === 0),
	);
});

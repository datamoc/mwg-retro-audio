import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstrumentMidiSink } from '../src/instruments/InstrumentMidiSink.ts';
import { psgInstruments } from '../src/instruments/psg.ts';
import { MidiPlayer } from '../src/formats/midi.ts';
import type { Instrument } from '../src/instruments/Instrument.ts';

const on = (channel: number, note: number, velocity = 90): [number, number, number] => [0x90 | channel, note, velocity];
const off = (channel: number, note: number): [number, number, number] => [0x80 | channel, note, 0];

function sink(polyphony: number): { sink: InstrumentMidiSink; calls: string[] } {
	const calls: string[] = [];
	const instrument = {
		info: { polyphony },
		chip: { id: 'fake', name: 'Fake', channels: 1, clock: 1, sampleRate: 8000 },
		noteOn: (note: number) => calls.push(`on ${note}`),
		noteOff: (note: number) => calls.push(`off ${note}`),
		allNotesOff: () => calls.push('all off'),
		render: () => {},
	} as unknown as Instrument;
	return { sink: new InstrumentMidiSink(instrument), calls };
}

test('percussion channel is ignored and note offs follow note ons', () => {
	const { sink: s, calls } = sink(4);
	s.event(...on(9, 36));
	s.event(...on(0, 60));
	s.event(...off(0, 60));
	assert.deepEqual(calls, ['on 60', 'off 60']);
});

test('the same pitch on two channels stays on until both release it', () => {
	const { sink: s, calls } = sink(4);
	s.event(...on(0, 60));
	s.event(...on(1, 60));
	s.event(...off(0, 60));
	assert.deepEqual(calls, ['on 60']);
	s.event(...off(1, 60));
	assert.deepEqual(calls, ['on 60', 'off 60']);
});

test('a full instrument keeps the melody and the bass and gives up the oldest middle note', () => {
	const { sink: s, calls } = sink(3);
	for (const note of [40, 60, 64]) s.event(...on(0, note));
	s.event(...on(0, 72));
	assert.deepEqual(calls.slice(3), ['off 60', 'on 72']);
	s.event(...on(0, 50));
	assert.deepEqual(calls.slice(5), ['off 64', 'on 50']);
	s.event(...on(0, 65));
	assert.deepEqual(calls.slice(7), ['off 50', 'on 65']);
});

test('with two voices a new middle note is dropped, and so is its release', () => {
	const { sink: s, calls } = sink(2);
	s.event(...on(0, 40));
	s.event(...on(0, 72));
	s.event(...on(0, 60));
	s.event(...off(0, 60));
	assert.deepEqual(calls, ['on 40', 'on 72']);
});

test('a single voice always follows the highest note', () => {
	const { sink: s, calls } = sink(1);
	s.event(...on(0, 60));
	s.event(...on(0, 48));
	assert.deepEqual(calls, ['on 60']);
	s.event(...on(0, 67));
	assert.deepEqual(calls, ['on 60', 'off 60', 'on 67']);
});

test('all notes off and a player reset release everything', () => {
	const { sink: s, calls } = sink(3);
	s.event(...on(0, 60));
	s.event(0xb0, 123, 0);
	s.event(...on(0, 60));
	assert.deepEqual(calls, ['on 60', 'all off', 'on 60']);
	s.chip.reset();
	assert.equal(calls.at(-1), 'all off');
});

test('a MidiPlayer drives a real YM2149 instrument and makes sound', () => {
	const instrument = psgInstruments
		.find((definition) => definition.info.id === 'ym2149')!
		.create({ sampleRate: 22050 });
	const events = [
		{ time: 0, status: 0x90, data1: 60, data2: 100 },
		{ time: 0.3, status: 0x80, data1: 60, data2: 0 },
	];
	const player = new MidiPlayer({ events, duration: 0.4 }, { sampleRate: 22050 }, new InstrumentMidiSink(instrument));
	const left = new Float32Array(22050);
	const right = new Float32Array(22050);
	const frames = player.render(left, right, 0, left.length);
	assert(frames > 0 && frames < left.length, 'the song ends');
	assert(left.some((value) => Math.abs(value) > 1e-4));
	assert.equal(instrument.activeNotes, 0);
});

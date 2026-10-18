import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { parseSmf, trimLeadingSilence } from '../src/formats/midi.ts';
import type { MidiSong } from '../src/formats/midi.ts';

const song: MidiSong = {
	title: 'Test',
	duration: 10,
	events: [
		{ time: 0, status: 0xc0, data1: 5, data2: 0 },
		{ time: 0, status: 0xb0, data1: 7, data2: 100 },
		{ time: 3, status: 0x90, data1: 60, data2: 0 }, // a note-on with velocity 0 is a note-off: not a first note
		{ time: 4, status: 0x90, data1: 60, data2: 90 },
		{ time: 6, status: 0x80, data1: 60, data2: 0 },
	],
};

test('the silence before the first note is cut and the setup messages stay at the start', () => {
	const trimmed = trimLeadingSilence(song);
	assert.deepEqual(
		trimmed.events.map((event) => [event.status, event.time]),
		[
			[0xc0, 0],
			[0xb0, 0],
			[0x90, 0],
			[0x90, 0],
			[0x80, 2],
		],
	);
	assert.equal(trimmed.duration, 6);
	assert.equal(trimmed.title, 'Test');
	assert.equal(song.events[3].time, 4, 'the original song is not changed');
});

test('a song that starts on its first note, or has no note, is returned as it is', () => {
	const immediate: MidiSong = { duration: 2, events: [{ time: 0, status: 0x90, data1: 60, data2: 90 }] };
	assert.equal(trimLeadingSilence(immediate), immediate);
	const silent: MidiSong = { duration: 2, events: [{ time: 1, status: 0xb0, data1: 7, data2: 100 }] };
	assert.equal(trimLeadingSilence(silent), silent);
	const empty: MidiSong = { duration: 0, events: [] };
	assert.equal(trimLeadingSilence(empty), empty);
});

test('every MIDI file of the demo starts on its first note once trimmed', () => {
	const folder = new URL('../examples/piano/music/', import.meta.url);
	const files = readdirSync(folder).filter((name) => name.endsWith('.mid'));
	assert(files.length >= 7);
	for (const name of files) {
		const original = parseSmf(new Uint8Array(readFileSync(new URL(name, folder))));
		const trimmed = trimLeadingSilence(original);
		const first = trimmed.events.find((event) => (event.status & 0xf0) === 0x90 && event.data2 > 0);
		assert(first && first.time === 0, `${name}: first note at ${first?.time}`);
		assert(trimmed.duration <= original.duration && trimmed.duration >= 0, name);
		assert.equal(trimmed.events.length, original.events.length, name);
	}
});

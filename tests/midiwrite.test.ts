import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmf } from '../src/formats/midi.ts';
import type { MidiEvent } from '../src/formats/midi.ts';
import { writeSmf } from '../src/formats/midiWrite.ts';

const played: MidiEvent[] = [
	{ time: 0, status: 0x90, data1: 60, data2: 100 },
	{ time: 0.5, status: 0x80, data1: 60, data2: 0 },
	{ time: 0.5, status: 0x90, data1: 64, data2: 80 },
	{ time: 0.75, status: 0xb0, data1: 64, data2: 127 },
	{ time: 1.25, status: 0xc0, data1: 5, data2: 0 },
	{ time: 3.5, status: 0x80, data1: 64, data2: 0 },
];

test('a written file is read back with the same messages and times', () => {
	const song = parseSmf(writeSmf(played, { title: 'Take 1' }));
	assert.equal(song.title, 'Take 1');
	assert.equal(song.events.length, played.length);
	played.forEach((event, index) => {
		const back = song.events[index];
		assert.equal(back.status, event.status);
		assert.equal(back.data1, event.data1);
		if (event.status >> 4 !== 0xc) assert.equal(back.data2, event.data2);
		assert(Math.abs(back.time - event.time) < 0.002, `event ${index}: ${back.time} against ${event.time}`);
	});
	assert(Math.abs(song.duration - 3.5) < 0.002);
});

test('events are written in time order and equal times keep their order', () => {
	const song = parseSmf(
		writeSmf([
			{ time: 2, status: 0x80, data1: 60, data2: 0 },
			{ time: 1, status: 0x90, data1: 60, data2: 90 },
			{ time: 2, status: 0x90, data1: 62, data2: 90 },
		]),
	);
	assert.deepEqual(
		song.events.map((event) => [event.status, event.data1]),
		[
			[0x90, 60],
			[0x80, 60],
			[0x90, 62],
		],
	);
});

test('the tempo and the resolution only change the file, not the time of the events', () => {
	const song = parseSmf(writeSmf(played, { ticksPerQuarter: 96, tempo: 400000 }));
	assert(Math.abs(song.duration - 3.5) < 0.005);
});

test('an empty recording is a valid file', () => {
	const song = parseSmf(writeSmf([]));
	assert.equal(song.events.length, 0);
});

test('data bytes are kept to seven bits and a title may use non ASCII characters', () => {
	const bytes = writeSmf([{ time: 0, status: 0x90, data1: 200, data2: 255 }], { title: 'Méditation' });
	const song = parseSmf(bytes);
	assert.equal(song.events[0].data1, 200 & 0x7f);
	assert.equal(song.events[0].data2, 127);
});

test('anything that is not a channel message, or a bad time or option, is refused', () => {
	assert.throws(() => writeSmf([{ time: 0, status: 0xf8, data1: 0, data2: 0 }]), RangeError);
	assert.throws(() => writeSmf([{ time: -1, status: 0x90, data1: 60, data2: 1 }]), RangeError);
	assert.throws(() => writeSmf([{ time: NaN, status: 0x90, data1: 60, data2: 1 }]), RangeError);
	assert.throws(() => writeSmf([], { ticksPerQuarter: 0 }), RangeError);
	assert.throws(() => writeSmf([], { tempo: 0 }), RangeError);
	assert.throws(() => writeSmf([{ time: 1e9, status: 0x90, data1: 60, data2: 1 }]), RangeError);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiPlayer } from '../src/formats/midi.ts';
import type { MidiEvent } from '../src/formats/midi.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { exportAudio } from '../src/driver/export.ts';
import { InstrumentMidiSink } from '../src/instruments/InstrumentMidiSink.ts';
import { instrumentCatalogue } from '../src/instruments/catalogue.ts';
import { decodeFlac } from './flacdecode.ts';

const RATE = 22050;
/** a take as the demo records it: two notes, the first one cut short, the pedal down at the end */
const take: MidiEvent[] = [
	{ time: 0, status: 0x90, data1: 60, data2: 100 },
	{ time: 0.4, status: 0x80, data1: 60, data2: 0 },
	{ time: 0.4, status: 0x90, data1: 67, data2: 90 },
	{ time: 0.9, status: 0x80, data1: 67, data2: 0 },
];
const duration = take[take.length - 1].time;

function renderTake(id: string): ReturnType<typeof renderPlayer> {
	const instrument = instrumentCatalogue
		.find((definition) => definition.info.id === id)!
		.create({ sampleRate: RATE });
	const player = new MidiPlayer({ events: take, duration }, { sampleRate: RATE }, new InstrumentMidiSink(instrument));
	return renderPlayer(player, { maxSeconds: duration + 2 });
}

test('a take rendered offline on the standard piano and on a chip has the length of the take and real sound', () => {
	for (const id of ['simple:Piano', 'ym2149']) {
		const result = renderTake(id);
		assert(result.ended, id);
		assert(Math.abs(result.duration - (duration + 0.5)) < 0.05, `${id}: ${result.duration} s`);
		assert(
			result.left.some((value) => Math.abs(value) > 1e-3),
			`${id} is silent`,
		);
		assert(result.left.every(Number.isFinite), id);
	}
});

test('the rendered take exports to a FLAC file that decodes to the same audio, and to WAV', async () => {
	const result = renderTake('simple:Piano');
	const flac = await exportAudio(result, 'flac', { tags: { TITLE: 'mwg-retro-audio recording' } });
	assert.equal(String.fromCharCode(...flac.subarray(0, 4)), 'fLaC');
	const decoded = decodeFlac(flac);
	assert.equal(decoded.sampleRate, RATE);
	assert.equal(decoded.totalSamples, result.left.length);
	assert(decoded.md5Matches, 'the MD5 of the decoded audio matches the header');
	assert(decoded.comments.some((comment) => comment.startsWith('TITLE=')));
	const wav = await exportAudio(result, 'wav');
	assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
	onMidiSynthFallback,
	parseMidi,
	registerMidiSynth,
	renderMidiToBuffer,
	renderMidiToBufferAsync,
	unregisterMidiSynth,
	type MidiSynthFallback,
} from '@datamoc/mwg/audio';
import { coreSources } from '../tools/worker-cores.mjs';
import * as audio from '@datamoc/mwg/audio';
import { renderNotesAsync } from '../src/mwg/notesRender.ts';
import { composeNotes, foldLoop } from '../src/compose/index.ts';
import { registerRetroWorkerMidiEngines } from '../src/mwg/workerEngines.ts';
import { retroMidiEngines } from '../src/mwg/midiEngines.ts';
import { retroCatalogueMidiEngines } from '../src/mwg/catalogueEngines.ts';

const source = resolve(import.meta.dirname, '..', 'src');
const cores = await coreSources({
	root: source,
	extension: '.ts',
	load: (module) => import(pathToFileURL(resolve(source, `${module}.ts`)).href),
});

/** a format 0 file, 480 ticks per quarter: two notes on channel 0, then the end of the track */
function tinyMidi(): Uint8Array {
	const track = [
		0x00, 0xc0, 0x00, 0x00, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0x00, 0x90, 67, 100, 0x83, 0x60, 0x80, 67, 0,
		0x00, 0xff, 0x2f, 0x00,
	];
	const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
	const chunk = [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length];
	return Uint8Array.from([...header, ...chunk, ...track]);
}

const RATE = 8000;
const core = (name: string): string | undefined => cores.get(name);

test('a worker engine is registered with the exact text of its core', () => {
	const registered = new Map<string, string | undefined>();
	registerRetroWorkerMidiEngines((name, _factory, worker) => registered.set(name, worker), retroMidiEngines, core);
	for (const name of Object.keys(retroMidiEngines)) assert.equal(registered.get(name), cores.get(name));
});

test('only engines with a packaged core become worker engines', () => {
	const calls: Array<[string, boolean]> = [];
	const hosted = registerRetroWorkerMidiEngines(
		(name, _factory, worker) => calls.push([name, worker !== undefined]),
		{ ...retroMidiEngines, 'retro:custom': retroMidiEngines['retro:dx7'] },
		core,
	);
	assert.deepEqual([...hosted].sort(), ['retro:d50', 'retro:dx7', 'retro:mt32']);
	assert.deepEqual(
		calls.find(([name]) => name === 'retro:custom'),
		['retro:custom', false],
	);
});

test('renderMidiToBufferAsync renders every engine of the catalogue on a worker with the output of the direct render', async () => {
	registerRetroWorkerMidiEngines(registerMidiSynth, retroCatalogueMidiEngines, core);
	const fell: MidiSynthFallback[] = [];
	const hear = (event: MidiSynthFallback): void => {
		fell.push(event);
	};
	onMidiSynthFallback.add(hear);
	try {
		const bytes = tinyMidi();
		for (const synth of Object.keys(retroCatalogueMidiEngines)) {
			const direct = renderMidiToBuffer(parseMidi(bytes), { synth, sampleRate: RATE, maxDuration: 2 });
			const async = await renderMidiToBufferAsync(bytes, { synth, sampleRate: RATE, maxDuration: 2 });
			assert.deepEqual(fell, [], `${synth} fell back: ${JSON.stringify(fell)}`);
			assert.ok(
				async.left.some((v) => Math.abs(v) > 1e-5),
				`${synth} made no sound`,
			);
			assert.deepEqual(async.left, direct.left, `${synth}: worker render differs from the direct render`);
			assert.deepEqual(async.right, direct.right, `${synth}: worker render differs from the direct render`);
		}
	} finally {
		onMidiSynthFallback.remove(hear);
		for (const name of Object.keys(retroCatalogueMidiEngines)) unregisterMidiSynth(name);
	}
});

const notes = [
	{ time: 0, status: 0x90, data1: 60, data2: 100 },
	{ time: 0.25, status: 0x80, data1: 60, data2: 0 },
	{ time: 0.25, status: 0x90, data1: 67, data2: 90 },
	{ time: 0.5, status: 0x80, data1: 67, data2: 0 },
];

test('generated notes render asynchronously on a worker engine to the samples of the direct render', async () => {
	registerRetroWorkerMidiEngines(registerMidiSynth, retroMidiEngines, core);
	try {
		const synth = 'retro:d50';
		const rendered = await renderNotesAsync(audio, notes, { synth, sampleRate: RATE });
		const direct = renderMidiToBuffer(audio.midiFileFromTimedMessages(notes), { synth, sampleRate: RATE });
		assert.ok(rendered.left.some((v) => Math.abs(v) > 1e-5));
		assert.deepEqual(rendered.left, direct.left);
		assert.deepEqual(rendered.right, direct.right);
	} finally {
		for (const name of Object.keys(retroMidiEngines)) unregisterMidiSynth(name);
	}
});

test('renderNotesAsync rejects invalid notes and an empty list, and honours an aborted signal', async () => {
	await assert.rejects(renderNotesAsync(audio, [{ time: -1, status: 0x90, data1: 60, data2: 90 }]), /event time/);
	await assert.rejects(renderNotesAsync(audio, []), /no notes/);
	await assert.rejects(renderNotesAsync(audio, notes, { signal: AbortSignal.abort() }));
});

test('a composed score is voiced by a retro engine on a worker and folded into a loop of the exact length', async () => {
	registerRetroWorkerMidiEngines(registerMidiSynth, retroMidiEngines, core);
	try {
		const score = composeNotes({ style: 'dos-opl2-1987', seed: 3, duration: 6 });
		const options = { synth: 'retro:mt32', sampleRate: RATE };
		const rendered = await renderNotesAsync(audio, score.events, options);
		assert.ok(rendered.left.some((v) => Math.abs(v) > 1e-5));
		assert.ok(rendered.duration >= score.seconds, 'the notes ring past the end of the loop');
		const loop = foldLoop(rendered, score.seconds);
		assert.equal(loop.left.length, Math.round(score.seconds * RATE));
		const energy = (x: Float32Array): number => x.reduce((sum, v) => sum + Math.abs(v), 0);
		assert.ok(energy(loop.left) > 0);
	} finally {
		for (const name of Object.keys(retroMidiEngines)) unregisterMidiSynth(name);
	}
});

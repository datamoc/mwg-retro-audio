import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { MidiSynth, MidiSynthFactory } from '@datamoc/mwg/audio';
import { coreSources, workerProblems } from '../tools/worker-cores.mjs';
import { retroCatalogueMidiEngines } from '../src/mwg/catalogueEngines.ts';

const RATE = 22050;
const source = resolve(import.meta.dirname, '..', 'src');
const sources = await coreSources({
	root: source,
	extension: '.ts',
	load: (module) => import(pathToFileURL(resolve(source, `${module}.ts`)).href),
});

/** what mwg's core host does with the text: an expression whose value is the factory */
const factoryOf = (text: string): MidiSynthFactory => (new Function(`return (${text});`) as () => MidiSynthFactory)();

function play(synth: MidiSynth, seconds: number): Float32Array {
	for (const note of [48, 55, 60, 67, 72]) synth.event(0x90, note, 100);
	const count = Math.round(seconds * RATE);
	const left = new Float32Array(count);
	const right = new Float32Array(count);
	for (let i = 0; i < count; i += 512) synth.render(left, right, i, Math.min(512, count - i));
	return left;
}

const names = Object.keys(retroCatalogueMidiEngines);

test('every engine of the catalogue has a packaged core, and nothing else does', () => {
	assert.deepEqual([...sources.keys()].sort(), [...names].sort());
});

test('a core is plain text a Worker can run: no import, eval, WebAssembly or DOM, and small', () => {
	for (const [name, text] of sources) {
		assert.deepEqual(workerProblems(text), [], `${name} is not fit for a Worker`);
		assert.ok(text.length < 80_000, `${name} is ${text.length} characters: bundle only what the engine needs`);
	}
	// a single-engine text must stay far under the 351 kB of one script holding mt32, dx7, d50 and the catalogue
	assert.ok(sources.get('retro:mt32')!.length < 60_000);
});

test('the text of each engine plays exactly what the engine itself plays', () => {
	for (const name of names) {
		const direct = play(retroCatalogueMidiEngines[name](RATE), 0.15);
		const packaged = play(factoryOf(sources.get(name)!)(RATE), 0.15);
		assert.deepEqual(packaged, direct, `${name}: the packaged core differs from the engine`);
		assert.ok(
			direct.some((v) => Math.abs(v) > 1e-4),
			`${name} made no sound`,
		);
	}
});

test('reset() brings an engine back to the state of a new one, so a replay is identical', () => {
	for (const name of names) {
		const fresh = play(retroCatalogueMidiEngines[name](RATE), 0.12);
		const used = retroCatalogueMidiEngines[name](RATE);
		play(used, 0.3); // sound, then silence, as the host's prefetch does
		used.reset();
		assert.deepEqual(play(used, 0.12), fresh, `${name}: render after reset() differs from a new engine`);
	}
});

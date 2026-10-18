import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	onMidiSynthFallback,
	parseMidi,
	registerMidiSynth,
	renderMidiThroughSynth,
	resolveMidiSynth,
	unregisterMidiSynth,
	type MidiSynthFallback,
} from '@datamoc/mw_games/audio';
import {
	registerRetroCatalogueMidiEngines,
	retroCatalogueMidiEngines,
	unregisterRetroCatalogueMidiEngines,
} from '../src/mwg/catalogueEngines.ts';
import { InstrumentMidiSynth, instrumentEngineName, instrumentMidiEngines } from '../src/mwg/instrumentEngines.ts';
import { instrumentCatalogue } from '../src/instruments/catalogue.ts';

/** a real file: "Ancient Mysteries" (Sperry Lion, CC0), a short loop, see examples/piano/README.md for its provenance */
const file = parseMidi(
	new Uint8Array(readFileSync(new URL('../examples/piano/music/ancient-mysteries.mid', import.meta.url))),
);
const RATE = 8000;

/** a short tune of three chords, so that every one of the engines can be rendered quickly */
const chords = [
	[60, 64, 67],
	[62, 65, 69],
	[55, 59, 62, 67],
];
const track: number[] = [0, 0xc0, 0];
for (const chord of chords) {
	chord.forEach((note, index) => track.push(0, 0x90 | index, note, 100));
	chord.forEach((note, index) => track.push(index === 0 ? 0x30 : 0, 0x80 | index, note, 64));
}
track.push(0, 0xff, 0x2f, 0);
const tune = parseMidi(
	Uint8Array.from([
		...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0x60],
		...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length],
		...track,
	]),
);
/** engines of different kinds, for the real file */
const sampled = ['retro:ym2149', 'retro:opl2', 'retro:dx7'];

test('every model of the catalogue is a named MIDI engine, the dedicated three kept', () => {
	const names = Object.keys(retroCatalogueMidiEngines);
	assert.equal(names.length, instrumentCatalogue.length);
	assert.equal(new Set(names).size, names.length, 'names are unique');
	for (const definition of instrumentCatalogue)
		assert(instrumentEngineName(definition.info.id) in retroCatalogueMidiEngines);
	assert(names.includes('retro:ym2149') && names.includes('retro:simple:electric-piano'));
	const generic = instrumentMidiEngines(instrumentCatalogue);
	for (const dedicated of ['retro:mt32', 'retro:dx7', 'retro:d50', 'retro:lapc-i'])
		assert.notEqual(retroCatalogueMidiEngines[dedicated], generic[dedicated], `${dedicated} keeps its own engine`);
});

test('mwg resolves each engine by name and voices a real MIDI file through it', () => {
	const registered = registerRetroCatalogueMidiEngines(registerMidiSynth);
	try {
		assert.equal(registered.length, instrumentCatalogue.length);
		for (const name of registered) {
			const { synth, name: used } = resolveMidiSynth(name, RATE, 'builtin');
			assert(synth, `${name} was not resolved`);
			assert.equal(used, name);
			const rendered = renderMidiThroughSynth(tune, synth, { tail: 0.2 });
			assert.equal(rendered.sampleRate, RATE, name);
			assert(rendered.duration > 0.5 && rendered.duration < 10, `${name}: ${rendered.duration} s`);
			assert(
				[...rendered.left.subarray(0, 4000), ...rendered.right.subarray(0, 4000)].every(Number.isFinite),
				name,
			);
			assert(
				rendered.left.some((value) => Math.abs(value) > 1e-5) ||
					rendered.right.some((value) => Math.abs(value) > 1e-5),
				`${name} is silent`,
			);
		}
	} finally {
		assert.equal(unregisterRetroCatalogueMidiEngines(unregisterMidiSynth).length, instrumentCatalogue.length);
	}
});

test('a real MIDI file is voiced, whole, by engines of several kinds', () => {
	registerRetroCatalogueMidiEngines(registerMidiSynth);
	try {
		for (const name of sampled) {
			const { synth } = resolveMidiSynth(name, 4000, 'builtin');
			assert(synth, name);
			const rendered = renderMidiThroughSynth(file, synth, { tail: 0.2 });
			assert(rendered.duration > 5, `${name}: ${rendered.duration} s`);
			assert(
				rendered.left.some((value) => Math.abs(value) > 1e-5),
				`${name} is silent`,
			);
		}
	} finally {
		unregisterRetroCatalogueMidiEngines(unregisterMidiSynth);
	}
});

test('an engine that is not registered, or that fails to build, makes mwg report the fallback', () => {
	const heard: MidiSynthFallback[] = [];
	const hear = (event: MidiSynthFallback): void => {
		heard.push(event);
	};
	onMidiSynthFallback.add(hear);
	try {
		registerMidiSynth('retro:broken', () => {
			throw new Error('no such chip');
		});
		assert.equal(resolveMidiSynth('retro:ym2149', RATE, 'builtin').synth, null, 'not registered yet');
		assert.equal(resolveMidiSynth('retro:broken', RATE, 'builtin').synth, null);
		assert.deepEqual(
			heard.map((event) => [event.requested, event.reason]),
			[
				['retro:ym2149', 'unknown'],
				['retro:broken', 'failed'],
			],
		);
	} finally {
		onMidiSynthFallback.remove(hear);
		unregisterMidiSynth('retro:broken');
	}
});

test('the generic engine merges channels, leaves percussion out, thins notes to its voices and resets cleanly', () => {
	const ym = instrumentCatalogue.find((definition) => definition.info.id === 'ym2149')!;
	const synth = new InstrumentMidiSynth(ym, RATE);
	const block = (): Float32Array => {
		const left = new Float32Array(2000);
		synth.render(left, new Float32Array(2000), 0, 2000);
		return left;
	};
	synth.event(0x99, 36, 100); // channel 10: percussion
	assert(
		block().every((value) => value === 0),
		'percussion is not voiced',
	);
	for (const note of [48, 60, 64, 67, 72]) synth.event(0x90 | (note % 3), note, 100); // five notes, three voices
	assert(block().some((value) => value !== 0));
	synth.event(0xe0, 0, 0x60); // bend up
	synth.event(0xb0, 64, 127);
	assert(block().every(Number.isFinite));
	synth.sysex();
	synth.reset();
	assert(
		block().every((value) => value === 0),
		'silent after reset',
	);
});

test('the Roland LAPC-I, the PC card of the MT-32 synthesizer, is a catalogue model that sounds like the MT-32', () => {
	const make = (id: string) =>
		instrumentCatalogue.find((definition) => definition.info.id === id)!.create({ sampleRate: 22050 });
	const card = make('lapc-i');
	assert.equal(card.info.family, 'card');
	assert.equal(card.info.name, 'Roland LAPC-I');
	const play = (instrument: ReturnType<typeof make>): Float32Array => {
		instrument.noteOn(60, 100);
		instrument.noteOn(67, 90);
		const left = new Float32Array(11025);
		instrument.render(left, new Float32Array(left.length), 0, left.length);
		return left;
	};
	const a = play(card);
	assert(a.some((value) => Math.abs(value) > 1e-3));
	assert.deepEqual(a, play(make('mt32')), 'the same LA model, the same notes, the same samples');
	assert.equal(
		retroCatalogueMidiEngines['retro:lapc-i'],
		retroCatalogueMidiEngines['retro:mt32'],
		'one MIDI engine, SysEx included',
	);
});

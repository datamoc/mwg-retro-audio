import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSf2, isSoundFont, SoundFontError } from '../src/formats/soundfont.ts';
import { SoundFontSynth } from '../src/chips/SoundFont.ts';
import { soundFontBankId, soundFontInstruments } from '../src/instruments/soundfont.ts';
import { instrumentMidiEngines } from '../src/mwg/instrumentEngines.ts';
import { InstrumentMidiSynth } from '../src/mwg/instrumentEngines.ts';
import { buildSf2, GEN, sine, type Sf2Spec } from './sf2file.ts';

const RATE = 44100;

/** one sine sample of 441 Hz (100 points a cycle at 44.1 kHz), root key 69, looped over its middle cycles */
const loopedSine = { name: 'Sine', data: sine(100, 8), rate: RATE, rootKey: 69, loopStart: 200, loopEnd: 600 };

function bank(
	options: Partial<Sf2Spec> & { instrumentGens?: [number, number][]; presetGens?: [number, number][] } = {},
) {
	const { instrumentGens, presetGens, ...rest } = options;
	return buildSf2({
		samples: [loopedSine],
		instruments: [
			{ name: 'Sine inst', zones: [{ gens: [[GEN.sampleModes, 1], ...(instrumentGens ?? [])], target: 0 }] },
		],
		presets: [{ name: 'Sine preset', zones: [{ gens: presetGens, target: 0 }] }],
		...rest,
	});
}

function synthFor(file: Uint8Array): SoundFontSynth {
	return new SoundFontSynth(parseSf2(file), { sampleRate: RATE });
}

function render(synth: SoundFontSynth, seconds: number): { left: Float32Array; right: Float32Array } {
	const left = new Float32Array(Math.round(RATE * seconds));
	const right = new Float32Array(left.length);
	synth.render(left, right, 0, left.length);
	return { left, right };
}

function magnitude(signal: Float32Array, hz: number): number {
	const w = (2 * Math.PI * hz) / RATE;
	let re = 0;
	let im = 0;
	for (let i = 0; i < signal.length; i++) {
		re += signal[i] * Math.cos(w * i);
		im += signal[i] * Math.sin(w * i);
	}
	return Math.hypot(re, im) / signal.length;
}

const peak = (signal: Float32Array, from = 0, to = signal.length): number => {
	let best = 0;
	for (let i = Math.floor(from); i < Math.min(to, signal.length); i++) best = Math.max(best, Math.abs(signal[i]));
	return best;
};

test('the structure of a bank is read: name, version, presets and samples', () => {
	const file = bank({ name: 'My bank' });
	assert(isSoundFont(file));
	const font = parseSf2(file);
	assert.equal(font.name, 'My bank');
	assert.equal(font.version, '2.4');
	assert.deepEqual(
		font.presets.map((preset) => [preset.name, preset.bank, preset.program]),
		[['Sine preset', 0, 0]],
	);
	assert.equal(font.samples.length, 1);
	assert.equal(font.samples[0].originalPitch, 69);
	assert.equal(font.samples[0].sampleRate, RATE);
});

test('key and velocity ranges choose the zones, a stereo sample gives two voices', () => {
	const samples = [
		{ ...loopedSine, name: 'Low' },
		{ ...loopedSine, name: 'High' },
		{ ...loopedSine, name: 'Left', type: 4 },
		{ ...loopedSine, name: 'Right', type: 2 },
	];
	const font = parseSf2(
		buildSf2({
			samples,
			instruments: [
				{
					name: 'Split',
					zones: [
						{ keyRange: [0, 59], target: 0 },
						{ keyRange: [60, 127], velRange: [0, 100], target: 1 },
						{ keyRange: [60, 127], velRange: [101, 127], target: 2, gens: [[GEN.pan, -500]] },
						{ keyRange: [60, 127], velRange: [101, 127], target: 3, gens: [[GEN.pan, 500]] },
					],
				},
			],
			presets: [{ name: 'Split preset', zones: [{ target: 0 }] }],
		}),
	);
	const names = (key: number, velocity: number): string[] =>
		font.voices(0, key, velocity).map((voice) => voice.sample.name);
	assert.deepEqual(names(40, 90), ['Low']);
	assert.deepEqual(names(72, 90), ['High']);
	assert.deepEqual(names(72, 120), ['Left', 'Right']);
	assert.deepEqual(names(72, 120).length, 2, 'a stereo sample is two voices');
	assert.deepEqual(font.voices(5, 60, 100), [], 'an unknown preset has no voice');
});

test('generators combine as the specification says: instrument sets, preset adds, global fills in', () => {
	const font = parseSf2(
		buildSf2({
			samples: [loopedSine],
			instruments: [
				{
					name: 'Inst',
					global: [[GEN.initialAttenuation, 100]],
					zones: [{ gens: [[GEN.coarseTune, 2]], target: 0 }],
				},
			],
			presets: [
				{ name: 'Preset', global: [[GEN.fineTune, 30]], zones: [{ gens: [[GEN.coarseTune, 1]], target: 0 }] },
			],
		}),
	);
	const [voice] = font.voices(0, 60, 100);
	assert.equal(voice.attenuationDb, 10, 'the instrument global value is the default of its zones');
	assert.equal(
		voice.tuneCents,
		(2 + 1) * 100 + 30,
		'coarse tune adds up across levels, fine tune comes from the preset',
	);
	assert.equal(voice.rootKey, 69);
});

test('a note plays at the pitch of its key, the root key at the sample pitch', () => {
	const synth = synthFor(bank());
	synth.noteOn(69, 127);
	const body = render(synth, 0.5).left.subarray(5000);
	assert(magnitude(body, 441) > magnitude(body, 500) * 5 && magnitude(body, 441) > magnitude(body, 220) * 5);
	synth.reset();
	synth.noteOn(81, 127);
	const octave = render(synth, 0.5).left.subarray(5000);
	assert(magnitude(octave, 882) > magnitude(octave, 441) * 5, 'an octave up doubles the frequency');
	synth.reset();
	synth.noteOn(57, 127);
	const down = render(synth, 0.5).left.subarray(5000);
	assert(magnitude(down, 220.5) > magnitude(down, 441) * 5, 'an octave down halves it');
});

test('tuning generators and the root key move the pitch', () => {
	const tuned = synthFor(bank({ instrumentGens: [[GEN.coarseTune, 12]] }));
	tuned.noteOn(69, 127);
	const body = render(tuned, 0.5).left.subarray(5000);
	assert(magnitude(body, 882) > magnitude(body, 441) * 5, '+12 semitones');
	const rooted = synthFor(bank({ instrumentGens: [[GEN.overridingRootKey, 57]] }));
	rooted.noteOn(69, 127);
	const body2 = render(rooted, 0.5).left.subarray(5000);
	assert(magnitude(body2, 882) > magnitude(body2, 441) * 5, 'root key 57 played at key 69');
	const flat = synthFor(bank({ instrumentGens: [[GEN.scaleTuning, 0]] }));
	flat.noteOn(93, 127);
	const body3 = render(flat, 0.5).left.subarray(5000);
	assert(magnitude(body3, 441) > magnitude(body3, 1764) * 5, 'scale tuning 0: every key plays the sample pitch');
});

test('a looped sample sustains, an unlooped one ends, a release fades out and frees the voices', () => {
	const looped = synthFor(bank());
	looped.noteOn(69, 127);
	const second = render(looped, 2).left;
	assert(peak(second, RATE * 1.5, RATE * 2) > 0.05, 'still sounding two seconds later');
	looped.noteOff(69);
	const after = render(looped, 1).left;
	assert(peak(after, RATE * 0.9) < 1e-3, 'silent after the release');
	assert.equal(looped.activeVoices, 0);

	const once = synthFor(bank({ instrumentGens: [[GEN.sampleModes, 0]] }));
	const font = parseSf2(bank({ instrumentGens: [[GEN.sampleModes, 0]] }));
	assert.equal(font.voices(0, 60, 100)[0].loopMode, 'none');
	once.noteOn(69, 127);
	const played = render(once, 1).left;
	assert(
		peak(played, 0, RATE * 0.1) > 0.05 && peak(played, RATE * 0.5) < 1e-4,
		'the 800 points are over after 18 ms',
	);
	assert.equal(once.activeVoices, 0);
});

test('the release time generator sets how fast a note fades', () => {
	const fade = (timecents: number): number => {
		const synth = synthFor(bank({ instrumentGens: [[GEN.releaseVolEnv, timecents]] }));
		synth.noteOn(69, 127);
		render(synth, 0.2);
		synth.noteOff(69);
		return peak(render(synth, 0.3).left, RATE * 0.28, RATE * 0.3);
	};
	assert(fade(-1200) < 1e-3, 'a half second release: 100 dB in 0.5 s, so 56 dB down after 0.28 s');
	assert(fade(1200) > fade(-1200) * 10, 'a two second release is still audible');
});

test('the attack generator makes the note rise slowly', () => {
	const slow = synthFor(bank({ instrumentGens: [[GEN.attackVolEnv, 1200]] }));
	slow.noteOn(69, 127);
	const rise = render(slow, 2).left;
	assert(
		peak(rise, 0, RATE * 0.1) < peak(rise, RATE * 1.5) * 0.15,
		'a one second attack: quiet at first, full later',
	);
});

test('attenuation, velocity and gain scale the level as the specification says', () => {
	const level = (gens: [number, number][], velocity = 127, gainDb = 0): number => {
		const synth = synthFor(bank({ instrumentGens: gens }));
		synth.gainDb = gainDb;
		synth.noteOn(69, velocity);
		return peak(render(synth, 0.3).left, 4000);
	};
	const reference = level([]);
	assert(Math.abs(level([[GEN.initialAttenuation, 200]]) / reference - 10 ** -1) < 0.02, '20 dB of attenuation');
	assert(Math.abs(level([], 64) / reference - (64 / 127) ** 2) < 0.02, 'amplitude follows the velocity squared');
	assert(Math.abs(level([], 127, -6) / reference - 10 ** (-6 / 20)) < 0.02, 'the player gain in dB');
});

test('pan sends a zone to one side, the player offset moves it', () => {
	const sides = (gens: [number, number][], offset = 0): [number, number] => {
		const synth = synthFor(bank({ instrumentGens: gens }));
		synth.panOffset = offset;
		synth.noteOn(69, 127);
		const { left, right } = render(synth, 0.3);
		return [peak(left, 4000), peak(right, 4000)];
	};
	const centre = sides([]);
	assert(Math.abs(centre[0] - centre[1]) < 0.02);
	const [hardLeft, rightOfLeft] = sides([[GEN.pan, -500]]);
	assert(hardLeft > 0.3 && rightOfLeft < 1e-3);
	const [leftOfRight, hardRight] = sides([[GEN.pan, 500]]);
	assert(hardRight > 0.3 && leftOfRight < 1e-3);
	const [moved] = sides([[GEN.pan, 500]], -0.5);
	assert(moved > 0.3, 'an offset of -50 % brings a right zone back to the left');
});

test('the low-pass cut-off removes the highs of a bright sample, and can be switched off', () => {
	const saw = {
		name: 'Saw',
		data: Int16Array.from({ length: 800 }, (_, i) => ((i % 100) / 100) * 40000 - 20000),
		rate: RATE,
		rootKey: 69,
		loopStart: 200,
		loopEnd: 600,
	};
	const make = (gens: [number, number][]): SoundFontSynth =>
		synthFor(
			buildSf2({
				samples: [saw],
				instruments: [{ name: 'Saw', zones: [{ gens: [[GEN.sampleModes, 1], ...gens], target: 0 }] }],
				presets: [{ name: 'Saw', zones: [{ target: 0 }] }],
			}),
		);
	const highs = (synth: SoundFontSynth): number => {
		synth.noteOn(69, 127);
		const { left } = render(synth, 0.3);
		return magnitude(left.subarray(4000), 441 * 8);
	};
	const open = highs(make([]));
	const closed = highs(make([[GEN.initialFilterFc, 5000]]));
	assert(closed < open * 0.2, `closed ${closed} against open ${open}`);
	const bypassed = make([[GEN.initialFilterFc, 5000]]);
	bypassed.useFilter = false;
	assert(highs(bypassed) > open * 0.8, 'the filter switch');
});

test('a note of many zones thins out the oldest notes beyond the voice limit and never grows without bound', () => {
	const synth = synthFor(bank());
	for (let note = 30; note < 130; note++) synth.noteOn(note % 100, 100);
	assert(synth.activeVoices <= 64);
	assert(render(synth, 0.1).left.every(Number.isFinite));
});

test('SF3, other versions, 24 bit only and garbage are refused with a clear error', () => {
	assert.throws(
		() => parseSf2(buildSf2({ samples: [loopedSine], instruments: [], presets: [], version: [3, 0] })),
		(error: Error) => error instanceof SoundFontError && /SF3|Vorbis/.test(error.message),
	);
	assert.throws(
		() => parseSf2(buildSf2({ samples: [loopedSine], instruments: [], presets: [], version: [1, 0] })),
		SoundFontError,
	);
	assert.throws(() => parseSf2(new Uint8Array(100)), SoundFontError);
	assert.throws(() => parseSf2(new Uint8Array([1, 2, 3])), SoundFontError);
	assert(!isSoundFont(new Uint8Array(100)));
});

test('a damaged bank is an error or still plays, never an endless loop or a read outside the data', () => {
	const file = bank();
	const started = performance.now();
	for (let length = 0; length < file.length; length += 7) {
		try {
			const font = parseSf2(file.subarray(0, length));
			const synth = new SoundFontSynth(font, { sampleRate: RATE });
			synth.noteOn(60, 100);
			render(synth, 0.05);
		} catch (error) {
			assert(error instanceof SoundFontError, `cut at ${length}: ${String(error)}`);
		}
	}
	let seed = 99;
	const next = (): number => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	for (let round = 0; round < 300; round++) {
		const copy = Uint8Array.from(file);
		for (let hits = 1 + Math.floor(next() * 4); hits > 0; hits--)
			copy[Math.floor(next() * copy.length)] = Math.floor(next() * 256);
		try {
			const font = parseSf2(copy);
			const synth = new SoundFontSynth(font, { sampleRate: RATE });
			for (let preset = 0; preset < font.presets.length; preset++) {
				synth.selectPreset(preset);
				synth.noteOn(60, 100);
			}
			const { left } = render(synth, 0.05);
			assert(left.every(Number.isFinite), `damage round ${round}: not finite`);
		} catch (error) {
			assert(error instanceof SoundFontError, `damage round ${round}: ${String(error)}`);
		}
	}
	assert(performance.now() - started < 10000, 'the damaged banks were handled quickly');
});

test('the presets become instruments with their own ids, controls and sound', () => {
	const font = parseSf2(
		buildSf2({
			name: 'Two presets.sf2',
			samples: [loopedSine],
			instruments: [{ name: 'I', zones: [{ gens: [[GEN.sampleModes, 1]], target: 0 }] }],
			presets: [
				{ name: 'First', program: 0, zones: [{ target: 0 }] },
				{ name: 'Second', program: 1, zones: [{ gens: [[GEN.coarseTune, 12]], target: 0 }] },
			],
		}),
	);
	assert.equal(soundFontBankId('My Bank (v2).SF2'), 'my-bank-v2');
	assert.equal(soundFontBankId('???'), 'bank');
	const definitions = soundFontInstruments(font, soundFontBankId('Two presets.sf2'));
	assert.deepEqual(
		definitions.map((definition) => definition.info.id),
		['soundfont:two-presets:0', 'soundfont:two-presets:1'],
	);
	assert.equal(definitions[0].info.family, 'sampler');
	const instrument = definitions[1].create({ sampleRate: RATE });
	assert.equal(instrument.controls.length, 6);
	instrument.noteOn(69, 127);
	const left = new Float32Array(RATE / 2);
	instrument.render(left, new Float32Array(left.length), 0, left.length);
	const body = left.subarray(5000);
	assert(magnitude(body, 882) > magnitude(body, 441) * 5, 'the second preset sounds an octave up');
	for (const control of instrument.controls) {
		if (control.kind === 'range') {
			control.set(control.max);
			assert.equal(control.get(), control.max);
			control.set(control.defaultValue);
		} else if (control.kind === 'toggle') {
			control.set(!control.defaultValue);
			assert.equal(control.get(), !control.defaultValue);
			control.set(control.defaultValue);
		}
	}
	instrument.noteOff(69);
	instrument.reset();
	assert.equal(instrument.activeNotes, 0);
});

test('each preset is also a named MIDI engine through the generic bridge', () => {
	const font = parseSf2(bank({ name: 'Bridge' }));
	const engines = instrumentMidiEngines(soundFontInstruments(font, 'bridge'));
	assert.deepEqual(Object.keys(engines), ['retro:soundfont:bridge:0']);
	const synth = engines['retro:soundfont:bridge:0'](RATE) as InstrumentMidiSynth;
	synth.event(0x90, 69, 127);
	const left = new Float32Array(RATE / 4);
	synth.render(left, new Float32Array(left.length), 0, left.length);
	assert(peak(left, 3000) > 0.05);
});

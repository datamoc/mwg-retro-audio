import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdditiveSynth, AiSynth, BreakPointEnvelope, LaSynth, Synclavier, Vl1 } from '../src/chips/historical.ts';
import { createChip } from '../src/chips/index.ts';
import { frequency, peak, renderMono, rms, RATE } from './util.ts';

test('break-point envelope: ramps, holds at its sustain point and releases to zero', () => {
	const e = new BreakPointEnvelope(
		[
			[0, 0],
			[0.1, 1],
			[0.2, 0.5],
		],
		2,
		0.1,
	);
	const dt = 0.01;
	const up: number[] = [];
	for (let i = 0; i < 25; i++) up.push(e.next(dt));
	assert.ok(up[4] > 0.4 && up[4] < 0.6, 'half way up at 0.05 s');
	assert.ok(Math.abs(up[24] - 0.5) < 1e-6, 'held at the sustain level');
	e.keyOff();
	let v = 1;
	for (let i = 0; i < 12; i++) v = e.next(dt);
	assert.equal(v, 0);
	assert.ok(e.done);
});

test('Bell Labs / Dartmouth additive bank: partial ratios, per-partial envelopes and the fixed oscillator count', () => {
	const bell = new AdditiveSynth({ sampleRate: RATE, preset: 'bellLabs' });
	assert.equal(bell.oscillators, 32);
	assert.equal(new AdditiveSynth({ sampleRate: RATE, preset: 'dartmouth' }).oscillators, 16);
	bell.loadPatch({
		partials: [
			{
				ratio: 1,
				amp: [
					[0, 1],
					[1, 1],
				],
			},
			{
				ratio: 2,
				amp: [
					[0, 0.5],
					[1, 0.5],
				],
			},
		],
	});
	bell.noteOn(69, 127);
	const out = renderMono(bell, 1);
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - 440) < 1, `${frequency(out, RATE)}`);
	// 17 notes of two partials do not fit 32 oscillators: the oldest notes are dropped
	for (let n = 40; n < 60; n++) bell.noteOn(n, 100);
	assert.ok(bell.used <= 32, `${bell.used} oscillators in use`);
	// a partial that fades out leaves the other one
	const fade = new AdditiveSynth({ sampleRate: RATE });
	fade.loadPatch({
		partials: [
			{
				ratio: 1,
				amp: [
					[0, 1],
					[0.3, 0],
					[3, 0],
				],
			},
			{
				ratio: 3,
				amp: [
					[0, 0.2],
					[3, 0.2],
				],
			},
		],
	});
	fade.noteOn(57, 127);
	const o = renderMono(fade, 1.5);
	assert.ok(
		Math.abs(frequency(o.subarray(Math.floor(RATE * 0.8)), RATE) - 3 * 220) < 3,
		'only the third harmonic remains',
	);
});

test('VL-1: pitch, digit controlled ADSR, a single voice', () => {
	const vl = new Vl1({ sampleRate: RATE });
	vl.sound = 'flute';
	vl.noteOn(69, 100);
	const out = renderMono(vl, 0.5);
	assert.ok(Math.abs(frequency(out, RATE, RATE / 8) - 440) < 2);
	vl.sound = 'adsr';
	vl.adsr = { attack: 8, decay: 0, sustain: 9, release: 0 };
	vl.noteOn(69, 100);
	const slow = renderMono(vl, 0.4);
	assert.ok(rms(slow, 0, 4000) < rms(slow, 10000, 14000) * 0.7, 'slow attack digit 8');
	vl.noteOn(60, 100);
	vl.noteOn(64, 100); // one voice: the last key wins
	const after = renderMono(vl, 1);
	assert.ok(Math.abs(frequency(after, RATE, RATE / 2) - 440 * 2 ** (-5 / 12)) < 3, `${frequency(after, RATE)}`);
});

test('Synclavier: stacked harmonics, FM between partials, polyphony of 8', () => {
	const s = new Synclavier({ sampleRate: RATE });
	s.loadPatch({
		partials: [
			{
				harmonics: [1, 0, 0.5],
				amp: [
					[0, 1],
					[1, 1],
				],
			},
		],
	});
	s.noteOn(69, 127);
	assert.ok(Math.abs(frequency(renderMono(s, 1), RATE, RATE / 4) - 440) < 1);
	const fm = new Synclavier({ sampleRate: RATE });
	fm.loadPatch({
		partials: [
			{
				harmonics: [1],
				fmIndex: 3,
				fmRatio: 2,
				amp: [
					[0, 1],
					[1, 1],
				],
			},
		],
	});
	fm.noteOn(69, 127);
	const plain = new Synclavier({ sampleRate: RATE });
	plain.loadPatch({
		partials: [
			{
				harmonics: [1],
				amp: [
					[0, 1],
					[1, 1],
				],
			},
		],
	});
	plain.noteOn(69, 127);
	assert.notDeepEqual(renderMono(fm, 0.1), renderMono(plain, 0.1));
	for (let n = 40; n < 60; n++) s.noteOn(n, 100);
	assert.ok(peak(renderMono(s, 0.1)) > 0.01);
});

test('LA / AI structures: synthesised partial through a resonant filter, PCM partial from a user ROM, registry ids', () => {
	const la = new LaSynth({ sampleRate: RATE });
	la.loadPatch([
		{
			wave: 'saw',
			cutoff: 8000,
			amp: [
				[0, 1],
				[1, 1],
			],
		},
	]);
	la.noteOn(57, 127);
	assert.ok(Math.abs(frequency(renderMono(la, 1), RATE, RATE / 4) - 220) < 1.5);
	// the filter really darkens the sound
	const dark = new LaSynth({ sampleRate: RATE });
	dark.loadPatch([
		{
			wave: 'saw',
			cutoff: 300,
			amp: [
				[0, 1],
				[1, 1],
			],
		},
	]);
	dark.noteOn(57, 127);
	assert.ok(rms(renderMono(dark, 0.5), 2000) < rms(renderMono(la, 0.5), 2000) * 0.6);
	// PCM partial: a 100 Hz sine sample at root note 60 played at 69 comes out a major sixth higher
	const rate = 32000;
	const sine = Float32Array.from({ length: 320 }, (_, i) => Math.sin((2 * Math.PI * i) / 320));
	const ai = new AiSynth({ sampleRate: RATE });
	ai.loadPatch([
		{
			wave: 'pcm',
			cutoff: 12000,
			pcm: { data: sine, rate, rootNote: 60, loopStart: 0, loopEnd: 320 },
			amp: [
				[0, 1],
				[1, 1],
			],
		},
	]);
	ai.noteOn(72, 127);
	assert.ok(
		Math.abs(frequency(renderMono(ai, 1), RATE, RATE / 4) - 200) < 2,
		`${frequency(renderMono(ai, 1), RATE)}`,
	);
	assert.equal(createChip('la-synth', { sampleRate: RATE }).id, 'la-synth');
	assert.equal(createChip('additive', { sampleRate: RATE }).id, 'additive');
});

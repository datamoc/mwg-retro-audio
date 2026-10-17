import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GS1_PRESETS, Gs1 } from '../src/chips/historical.ts';
import { createChip } from '../src/chips/index.ts';
import { frequency, peak, renderMono, rms, RATE } from './util.ts';

const SUSTAIN: [number, number][] = [
	[0, 1],
	[1, 1],
];

test('GS-1: registry id, 16 factory preset names, preset selection by write(128)', () => {
	assert.equal(createChip('gs1', { sampleRate: RATE }).id, 'gs1');
	assert.equal(GS1_PRESETS.length, 16);
	assert.equal(GS1_PRESETS[0].name, 'Harpsichord I');
	assert.equal(GS1_PRESETS[15].name, 'Pipe Organ');
	const g = new Gs1({ sampleRate: RATE });
	g.write(128, 9); // Electric Piano I
	assert.equal(g.preset, 9);
	// two different presets do not sound the same
	const a = new Gs1({ sampleRate: RATE });
	a.selectPreset(4); // Vibraphone
	a.noteOn(69, 127);
	const b = new Gs1({ sampleRate: RATE });
	b.selectPreset(13); // Electronic Organ I
	b.noteOn(69, 127);
	assert.notDeepEqual(renderMono(a, 0.2), renderMono(b, 0.2));
});

test('GS-1: one FM pair plays at pitch, the modulator creates sidebands', () => {
	const plain = new Gs1({ sampleRate: RATE });
	plain.loadPatch({ pairs: [{ carrierRatio: 1, modRatio: 1, modIndex: 0, carrier: SUSTAIN, modulator: SUSTAIN }] });
	plain.noteOn(69, 127);
	const sine = renderMono(plain, 1);
	assert.ok(Math.abs(frequency(sine, RATE, RATE / 4) - 440) < 1.5, `${frequency(sine, RATE)}`);
	const fm = new Gs1({ sampleRate: RATE });
	fm.loadPatch({ pairs: [{ carrierRatio: 1, modRatio: 1, modIndex: 3, carrier: SUSTAIN, modulator: SUSTAIN }] });
	fm.noteOn(69, 127);
	const bright = renderMono(fm, 0.2);
	assert.notDeepEqual(bright, sine.subarray(0, bright.length));
	// FM energy spreads above the fundamental: high-band content the pure sine does not have
	const diff = bright.map((v, i) => v - sine[i]);
	assert.ok(rms(diff, 4000) > 0.05, 'modulator index 3 audibly changes the wave');
});

test('GS-1: cross-modulation between pairs changes the output', () => {
	const mk = (cross?: number): Gs1 => {
		const g = new Gs1({ sampleRate: RATE });
		g.loadPatch({
			pairs: [
				{ carrierRatio: 1, modRatio: 1, modIndex: 1, carrier: SUSTAIN, modulator: SUSTAIN },
				{ carrierRatio: 2, modRatio: 1, modIndex: 1, carrier: SUSTAIN, modulator: SUSTAIN, cross },
			],
		});
		g.noteOn(69, 127);
		return g;
	};
	assert.notDeepEqual(renderMono(mk(0), 0.1), renderMono(mk(), 0.1));
});

test('GS-1: polyphony is capped at 16 voices, release silences a note', () => {
	const g = new Gs1({ sampleRate: RATE });
	g.selectPreset(13); // organ: sustained
	for (let n = 40; n < 60; n++) g.noteOn(n, 100);
	assert.equal(g.activeVoices, 16, `${g.activeVoices}`);
	assert.ok(peak(renderMono(g, 0.2)) > 0.01);
	const one = new Gs1({ sampleRate: RATE });
	one.loadPatch({
		pairs: [{ carrierRatio: 1, modRatio: 1, modIndex: 1, carrier: SUSTAIN, modulator: SUSTAIN }],
		release: 0.05,
	});
	one.noteOn(69, 127);
	renderMono(one, 0.2);
	one.noteOff(69);
	const tail = renderMono(one, 0.5);
	assert.ok(rms(tail, tail.length - 4000) < 1e-4, 'silent after release');
	assert.equal(one.activeVoices, 0);
});

test('GS-1: vibrato and tremolo controls modulate the output', () => {
	const mk = (on: boolean): Gs1 => {
		const g = new Gs1({ sampleRate: RATE });
		g.loadPatch({ pairs: [{ carrierRatio: 1, modRatio: 1, modIndex: 0, carrier: SUSTAIN, modulator: SUSTAIN }] });
		if (on) {
			g.vibrato = { rate: 5, depth: 0.01 };
			g.tremolo = { rate: 4, depth: 0.5 };
		}
		g.noteOn(69, 127);
		return g;
	};
	assert.notDeepEqual(renderMono(mk(true), 0.3), renderMono(mk(false), 0.3));
});

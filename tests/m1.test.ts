import { test } from 'node:test';
import assert from 'node:assert/strict';
import { M1_PRESETS, M1Synth } from '../src/chips/M1.ts';
import { M1_LOOPS } from '../src/chips/m1Data.ts';
import { M1_ATTACKS } from '../src/chips/m1Data.ts';
import { createChip } from '../src/chips/index.ts';
import { frequency, peak, renderMono, renderStereo, rms, RATE } from './util.ts';

const HOLD: [number, number][] = [
	[0, 1],
	[1, 1],
];

const plain = (loop = 14, extra: object = {}): M1Synth => {
	const s = new M1Synth({ sampleRate: RATE });
	s.loadProgram({ oscs: [{ loop }], cutoff: 18000, amp: HOLD, release: 0.05, velocitySens: 0, ...extra });
	return s;
};

test('M1 (no ROM): registry id, deterministic generated banks, presets by write(128)', () => {
	assert.equal(createChip('m1', { sampleRate: RATE }).id, 'm1');
	assert.equal(M1_LOOPS.length, 16);
	assert.equal(M1_ATTACKS.length, 16);
	for (const l of M1_LOOPS) assert.ok(l.length === 16 && l.every((v) => v >= 0 && v <= 1) && Math.max(...l) === 1);
	assert.ok(M1_PRESETS.length >= 16);
	const a = new M1Synth({ sampleRate: RATE });
	const b = new M1Synth({ sampleRate: RATE });
	a.write(128, 3);
	b.write(128, 3);
	assert.equal(a.preset, 3);
	a.noteOn(60, 100);
	b.noteOn(60, 100);
	assert.deepEqual(renderMono(a, 0.3), renderMono(b, 0.3));
	for (let i = 0; i < M1_PRESETS.length; i++) {
		const s = new M1Synth({ sampleRate: RATE });
		s.write(128, i);
		s.noteOn(64, 110);
		const out = renderMono(s, 0.4);
		assert.ok(out.every(Number.isFinite) && peak(out) > 0.01, `${M1_PRESETS[i].name} makes sound`);
	}
});

test('M1: pitch follows the key for a plain loop, an octave transposition doubles it', () => {
	const s = plain();
	s.noteOn(69, 127);
	assert.ok(Math.abs(frequency(renderMono(s, 1), RATE, RATE / 4) - 440) < 2);
	const up = plain(14, { oscs: [{ loop: 14, octave: 1 }] });
	up.noteOn(69, 127);
	assert.ok(Math.abs(frequency(renderMono(up, 1), RATE, RATE / 4) - 880) < 4);
});

test('M1: a brighter measured spectrum is brighter, the one-shot attack ends while the key is held', () => {
	const mk = (loop: number): Float32Array => {
		const s = plain(loop);
		s.noteOn(57, 127);
		return renderMono(s, 0.5);
	};
	const dx = (x: Float32Array): number => {
		let s = 0;
		for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) ** 2;
		return s / (rms(x) ** 2 * x.length);
	};
	assert.ok(dx(mk(1)) > dx(mk(14)) * 4, 'loop 1 has far more high harmonics than loop 15');
	const s = new M1Synth({ sampleRate: RATE });
	s.loadProgram({
		oscs: [{ loop: 15, attack: 0, attackLevel: 1, level: 0 }],
		cutoff: 18000,
		amp: HOLD,
		velocitySens: 0,
	});
	s.noteOn(60, 127);
	const out = renderMono(s, 2);
	assert.ok(rms(out, 0, 1000) > 0.005, 'transient at the start');
	assert.ok(rms(out, out.length - 4000) < 1e-4, 'the transient is over while the key is still down');
});

test('M1: velocity scales the level, release ends the voice, effects widen the image', () => {
	const level = (vel: number): number => {
		const s = plain(14, { velocitySens: 1 });
		s.noteOn(60, vel);
		return rms(renderMono(s, 0.3), 2000);
	};
	assert.ok(level(127) > level(30) * 2);
	const s = plain();
	s.noteOn(60, 100);
	renderMono(s, 0.2);
	s.noteOff(60);
	const tail = renderMono(s, 0.5);
	assert.ok(rms(tail, tail.length - 4000) < 1e-4);
	assert.equal(s.activeVoices, 0);
	const fx = plain(14, { chorus: { mix: 0.5 } });
	fx.noteOn(60, 100);
	const [l, r] = renderStereo(fx, 0.3);
	assert.notDeepEqual(l, r);
	const dry = plain();
	dry.noteOn(60, 100);
	const [dl, dr] = renderStereo(dry, 0.1);
	assert.deepEqual(dl, dr);
});

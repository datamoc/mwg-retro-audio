import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meanBandShape } from '../src/driver/analysis.ts';
import { applyToneGains, toneMatchGains } from '../src/compose/tone.ts';

const RATE = 22050;

function tones(frequencies: number[], seconds: number): Float32Array {
	const x = new Float32Array(Math.round(seconds * RATE));
	for (const hz of frequencies)
		for (let i = 0; i < x.length; i++) x[i] += 0.2 * Math.sin((2 * Math.PI * hz * i) / RATE);
	return x;
}

const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

test('flat gains leave a signal unchanged', () => {
	const x = tones([200, 1000], 2);
	const y = Float32Array.from(x);
	applyToneGains([y], new Array(32).fill(0), RATE);
	let worst = 0;
	for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i]));
	assert.ok(worst < 1e-3, `worst difference ${worst}`);
});

test('a band gain raises its tones and leaves the others', () => {
	const x = tones([150, 3000], 2);
	const gains = new Array(32).fill(0);
	for (let k = 0; k < 8; k++) gains[k] = 12; // the lowest bands, up to about 180 Hz
	const low = Float32Array.from(tones([150], 2));
	const high = Float32Array.from(tones([3000], 2));
	applyToneGains([low], gains, RATE);
	applyToneGains([high], gains, RATE);
	assert.ok(rms(low) > 2.5 * rms(tones([150], 2)));
	assert.ok(Math.abs(rms(high) / rms(tones([3000], 2)) - 1) < 0.1);
	assert.ok(x.length > 0);
});

function noise(seconds: number): Float32Array {
	const x = new Float32Array(Math.round(seconds * RATE));
	let state = 12345;
	for (let i = 0; i < x.length; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		x[i] = 0.3 * (state / 0x80000000 - 1);
	}
	return x;
}

test('matching moves the shape of a signal towards the target', () => {
	const x = noise(4);
	const before = meanBandShape(x, RATE);
	// a step of one natural log power unit (about 4 dB) on the lowest bands; a band shape has no overall level
	const stepped = before.map((v, k) => v + (k < 10 ? 1 : 0));
	const level = stepped.reduce((a, c) => a + c, 0) / stepped.length;
	const target = stepped.map((v) => v - level);
	const y = Float32Array.from(x);
	applyToneGains([y], toneMatchGains(x, target, RATE), RATE);
	const distance = (a: number[]): number => a.reduce((s, v, k) => s + Math.abs(v - target[k]), 0) / a.length;
	assert.ok(distance(meanBandShape(y, RATE)) < 0.5 * distance(before));
});

test('the loop point stays continuous after matching', () => {
	const x = tones([220, 440], 2);
	const y = Float32Array.from(x);
	applyToneGains([y], toneMatchGains(x, new Array(32).fill(0), RATE), RATE);
	let inside = 0;
	for (let i = 0; i < y.length - 1; i++) inside = Math.max(inside, Math.abs(y[i + 1] - y[i]));
	assert.ok(Math.abs(y[0] - y[y.length - 1]) <= inside * 1.5);
});

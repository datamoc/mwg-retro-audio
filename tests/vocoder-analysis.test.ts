import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTempo, pitchClassProfile, spectralDistance } from '../src/driver/analysis.ts';
import { vocode } from '../src/speech/Vocoder.ts';

const RATE = 22050;

function tone(hz: number, seconds: number): Float32Array {
	const x = new Float32Array(Math.round(seconds * RATE));
	for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * hz * i) / RATE);
	return x;
}

function saw(hz: number, seconds: number): Float32Array {
	const x = new Float32Array(Math.round(seconds * RATE));
	for (let i = 0; i < x.length; i++) x[i] = 2 * ((hz * i) / RATE - Math.floor((hz * i) / RATE + 0.5));
	return x;
}

function magnitude(x: Float32Array, hz: number): number {
	let re = 0;
	let im = 0;
	for (let i = 0; i < x.length; i++) {
		re += x[i] * Math.cos((2 * Math.PI * hz * i) / RATE);
		im += x[i] * Math.sin((2 * Math.PI * hz * i) / RATE);
	}
	return Math.hypot(re, im);
}

test('a vocoder keeps the carrier pitch and takes the spectral shape of the modulator', () => {
	const out = vocode(tone(1000, 1), saw(110, 1), { sampleRate: RATE });
	// the modulator has energy near 1 kHz only: the carrier harmonics near 1 kHz survive, those near 4 kHz do not
	assert.ok(magnitude(out, 990) > 8 * magnitude(out, 3960));
	// the fundamental of the carrier is not at 1 kHz, so the output is not the modulator
	assert.ok(magnitude(out, 110) < magnitude(out, 990));
});

test('a vocoder is silent when the modulator is silent', () => {
	const out = vocode(new Float32Array(RATE), saw(110, 1), { sampleRate: RATE });
	assert.ok(out.every((s) => Math.abs(s) < 1e-6));
});

test('tempo estimation finds the pulse rate of a click track', () => {
	const x = new Float32Array(RATE * 12);
	const period = (RATE * 60) / 120;
	for (let t = 0; t < x.length; t += period)
		for (let i = 0; i < 200 && t + i < x.length; i++) x[Math.floor(t) + i] = 1 - i / 200;
	const [best] = estimateTempo(x, RATE);
	assert.ok(Math.abs(best - 120) < 1.5, `got ${best}`);
});

test('the pitch class profile peaks on the played note', () => {
	const profile = pitchClassProfile(tone(440, 4), RATE);
	let top = 0;
	for (let i = 1; i < 12; i++) if (profile[i] > profile[top]) top = i;
	assert.equal(top, 9); // A
});

test('spectral distance is zero for equal signals and grows with a different spectrum', () => {
	const a = tone(440, 1);
	assert.equal(spectralDistance(a, a, RATE), 0);
	assert.ok(spectralDistance(a, tone(1760, 1), RATE) > 1);
	assert.ok(spectralDistance(a, tone(445, 1), RATE) < spectralDistance(a, tone(1760, 1), RATE));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentCatalogue } from '../src/instruments/catalogue.ts';
import type { InstrumentDef } from '../src/instruments/Instrument.ts';

const RATE = 44100;

/** the left channel of a note held for `seconds` */
function play(def: InstrumentDef, note: number, seconds: number): Float32Array {
	const instrument = def.create({ sampleRate: RATE });
	instrument.noteOn(note, 100);
	const count = Math.round(seconds * RATE);
	const left = new Float32Array(count);
	const right = new Float32Array(count);
	for (let i = 0; i < count; i += 512) instrument.render(left, right, i, Math.min(512, count - i));
	return left;
}

const rms = (x: Float32Array): number => Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length);

/** share of the energy of `x` (mean removed) that sits on the fundamental `hz` and its first harmonics */
function pitchShare(x: Float32Array, hz: number): number {
	const mean = x.reduce((sum, v) => sum + v, 0) / x.length;
	const centred = x.map((v) => v - mean);
	const total = centred.reduce((sum, v) => sum + v * v, 0) / centred.length;
	if (total < 1e-12) return 0;
	const power = (frequency: number): number => {
		const w = (2 * Math.PI * frequency) / RATE;
		let re = 0;
		let im = 0;
		for (let i = 0; i < centred.length; i++) {
			re += centred[i] * Math.cos(w * i);
			im += centred[i] * Math.sin(w * i);
		}
		return (2 * (re * re + im * im)) / (centred.length * centred.length);
	};
	let share = 0;
	for (let harmonic = 1; harmonic <= 6 && hz * harmonic < RATE / 2; harmonic++) {
		let best = 0;
		for (let cents = -40; cents <= 40; cents += 10)
			best = Math.max(best, power(hz * harmonic * 2 ** (cents / 1200)));
		share += best;
	}
	return share / total;
}

const hzOf = (note: number): number => 440 * 2 ** ((note - 69) / 12);

test('every model sounds on the low, middle and high notes of a song, without NaN or clipping', () => {
	for (const def of instrumentCatalogue) {
		for (const note of [48, 60, 72]) {
			const x = play(def, note, 0.5).subarray(Math.round(0.03 * RATE), Math.round(0.4 * RATE));
			assert.ok(
				x.every((v) => Number.isFinite(v) && Math.abs(v) <= 1.5),
				`${def.info.id} note ${note}: not finite or too loud`,
			);
			assert.ok(rms(x) > 0.002, `${def.info.id} note ${note}: silent (rms ${rms(x)})`);
		}
	}
});

// chips whose notes used to come out constant, an octave low, or silent below a limit
const PITCHED: [string, number[]][] = [
	['pcm-dac', [36, 48, 60, 72]],
	['vrc6', [36, 48, 60, 69]],
	['nes-apu', [36, 40, 45, 60]],
	['nes-apu-pal', [36, 45, 60]],
	['mmc5', [36, 40, 45, 60]],
	['ym2612', [48, 72]],
	['ym2203', [48, 60, 72]],
	['ym2608', [48, 60, 72]],
];
for (const [id, notes] of PITCHED) {
	test(`${id} plays the note asked for, down to its low range`, () => {
		const def = instrumentCatalogue.find((d) => d.info.id === id)!;
		for (const note of notes) {
			const x = play(def, note, 0.8).subarray(Math.round(0.3 * RATE), Math.round(0.7 * RATE));
			const share = pitchShare(x, hzOf(note));
			assert.ok(
				share > 0.4,
				`${id} note ${note} (${hzOf(note).toFixed(1)} Hz): energy on the pitch ${share.toFixed(2)}`,
			);
		}
	});
}

test('the sample DAC mixes several notes and goes quiet after the release', () => {
	const def = instrumentCatalogue.find((d) => d.info.id === 'pcm-dac')!;
	const instrument = def.create({ sampleRate: RATE });
	for (const note of [60, 64, 67]) instrument.noteOn(note, 100);
	const chord = new Float32Array(RATE / 2);
	const right = new Float32Array(chord.length);
	for (let i = 0; i < chord.length; i += 512) instrument.render(chord, right, i, 512);
	for (const note of [60, 64, 67])
		assert.ok(pitchShare(chord.subarray(8000), hzOf(note)) > 0.1, `chord note ${note} missing`);
	for (const note of [60, 64, 67]) instrument.noteOff(note);
	const tail = new Float32Array(RATE);
	for (let i = 0; i < tail.length; i += 512) instrument.render(tail, right, i, 512);
	assert.ok(rms(tail.subarray(RATE - 4410)) < 1e-3, 'the DAC kept sounding after the release');
});

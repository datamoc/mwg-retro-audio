import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DX7_CARRIERS, Dx7Synth } from '../src/chips/Dx7.ts';
import { dx7Checksum, parseDx7Single, type Dx7Operator, type Dx7Voice } from '../src/formats/dx7.ts';
import { compareAudio } from '../src/driver/Compare.ts';
import { frequency, peak, renderMono, rms, RATE } from './util.ts';

const op = (over: Partial<Dx7Operator> = {}): Dx7Operator => ({
	rates: [99, 99, 99, 99],
	levels: [99, 99, 99, 0],
	breakPoint: 39,
	leftDepth: 0,
	rightDepth: 0,
	leftCurve: 0,
	rightCurve: 0,
	rateScale: 0,
	detune: 7,
	ampModSens: 0,
	keyVelocitySens: 0,
	outputLevel: 99,
	oscMode: 0,
	freqCoarse: 1,
	freqFine: 0,
	...over,
});

/** algorithm 32 (all operators are carriers): operator 6 sounds, the others are silent unless given */
function voice(over: Partial<Dx7Voice> = {}, ops: Partial<Dx7Operator>[] = []): Dx7Voice {
	const silent = { outputLevel: 0 };
	return {
		name: 'TEST',
		operators: Array.from({ length: 6 }, (_, i) => op(i === 0 ? ops[0] : { ...silent, ...ops[i] })),
		pitchEgRates: [99, 99, 99, 99],
		pitchEgLevels: [50, 50, 50, 50],
		algorithm: 31,
		feedback: 0,
		oscKeySync: true,
		lfo: { speed: 35, delay: 0, pitchModDepth: 0, ampModDepth: 0, sync: true, wave: 4, pitchModSens: 0 },
		transpose: 24,
		...over,
	};
}

test('algorithm table: carriers per algorithm match the DX7 chart', () => {
	assert.equal(DX7_CARRIERS.length, 32);
	assert.equal(DX7_CARRIERS[0], 2, 'algorithm 1: operators 1 and 3');
	assert.equal(DX7_CARRIERS[4], 3, 'algorithm 5: three 2-operator pairs');
	assert.equal(DX7_CARRIERS[31], 6, 'algorithm 32: six carriers');
});

test('A4 plays at 440 Hz, at the native rate and when generated directly at the output rate', () => {
	for (const nativeRate of [true, false]) {
		const synth = new Dx7Synth({ sampleRate: RATE, nativeRate });
		synth.loadVoice(voice());
		synth.noteOn(69, 100);
		const out = renderMono(synth, 1);
		assert.ok(
			Math.abs(frequency(out, RATE, RATE / 4) - 440) < 0.6,
			`native=${nativeRate}: ${frequency(out, RATE)}`,
		);
		assert.ok(peak(out) > 0.05);
	}
});

test('envelope times do not depend on the output rate (they follow the 49096 Hz machine)', () => {
	const slow = voice({}, [{ rates: [50, 99, 99, 60], levels: [99, 99, 99, 0] }]);
	const riseTime = (rate: number): number => {
		const synth = new Dx7Synth({ sampleRate: rate });
		synth.loadVoice(slow);
		synth.noteOn(69, 100);
		const n = Math.floor(rate * 2);
		const l = new Float32Array(n);
		synth.render(l, new Float32Array(n), 0, n);
		const win = Math.floor(rate / 100);
		let final = 0;
		for (let i = n - win; i < n; i++) final = Math.max(final, Math.abs(l[i]));
		for (let i = 0; i < n - win; i += win) {
			let m = 0;
			for (let j = i; j < i + win; j++) m = Math.max(m, Math.abs(l[j]));
			if (m >= final / 2) return i / rate;
		}
		return Infinity;
	};
	const a = riseTime(44100);
	const b = riseTime(96000);
	assert.ok(Number.isFinite(a) && a > 0.02, `rise ${a}`);
	assert.ok(Math.abs(a - b) / a < 0.15, `${a} s at 44.1 kHz vs ${b} s at 96 kHz`);
});

test('key off releases the note, operator switches, velocity sensitivity', () => {
	const synth = new Dx7Synth({ sampleRate: RATE });
	synth.loadVoice(voice({}, [{ rates: [99, 99, 99, 70], levels: [99, 99, 99, 0], keyVelocitySens: 7 }]));
	synth.noteOn(69, 127);
	const a = renderMono(synth, 0.3);
	synth.noteOff(69);
	renderMono(synth, 1.5);
	assert.ok(peak(renderMono(synth, 0.1)) < 0.002, 'silent after the release');
	synth.noteOn(69, 20);
	const quiet = renderMono(synth, 0.3);
	assert.ok(peak(a) > peak(quiet) * 1.5, `velocity: ${peak(a)} vs ${peak(quiet)}`);
	synth.reset();
	synth.setOperatorEnabled(6, false);
	synth.noteOn(69, 100);
	assert.ok(
		peak(renderMono(synth, 0.2)) < 1e-3,
		'operator 6 switched off (the silent operators stay at the 84 dB floor)',
	);
});

test('pitch bend, LFO vibrato and the modulation wheel move the pitch', () => {
	const synth = new Dx7Synth({ sampleRate: RATE });
	synth.loadVoice(voice());
	synth.noteOn(69, 100);
	synth.setPitchBend(1);
	const bent = renderMono(synth, 1);
	assert.ok(Math.abs(frequency(bent, RATE, RATE / 4) / 440 - 2 ** (2 / 12)) < 0.004, `${frequency(bent, RATE)}`);
	const vibrato = new Dx7Synth({ sampleRate: RATE });
	vibrato.loadVoice(
		voice({
			lfo: { speed: 40, delay: 0, pitchModDepth: 99, ampModDepth: 0, sync: true, wave: 4, pitchModSens: 7 },
		}),
	);
	vibrato.noteOn(69, 100);
	const v = renderMono(vibrato, 2);
	const freqs: number[] = [];
	for (let i = 0; i < 8; i++)
		freqs.push(frequency(v.subarray(Math.floor(RATE * (0.5 + i * 0.1)), Math.floor(RATE * (0.6 + i * 0.1))), RATE));
	assert.ok(
		Math.max(...freqs) - Math.min(...freqs) > 5,
		`vibrato spread ${Math.max(...freqs) - Math.min(...freqs)} Hz`,
	);
	const wheel = new Dx7Synth({ sampleRate: RATE });
	wheel.loadVoice(
		voice({ lfo: { speed: 40, delay: 0, pitchModDepth: 0, ampModDepth: 0, sync: true, wave: 4, pitchModSens: 7 } }),
	);
	wheel.noteOn(69, 100);
	const flat = renderMono(wheel, 1);
	wheel.setModWheel(1);
	const wob: number[] = [];
	const w = renderMono(wheel, 2);
	for (let i = 0; i < 8; i++)
		wob.push(frequency(w.subarray(Math.floor(RATE * (0.5 + i * 0.1)), Math.floor(RATE * (0.6 + i * 0.1))), RATE));
	assert.ok(Math.max(...wob) - Math.min(...wob) > 5, 'the wheel opens the vibrato');
	assert.ok(Math.abs(frequency(flat, RATE, RATE / 4) - 440) < 1, 'no vibrato without depth or wheel');
});

test('amplitude modulation attenuates the operators that have a sensitivity', () => {
	const make = (ams: number): Dx7Synth => {
		const s = new Dx7Synth({ sampleRate: RATE });
		s.loadVoice(
			voice(
				{
					lfo: {
						speed: 30,
						delay: 0,
						pitchModDepth: 0,
						ampModDepth: 99,
						sync: true,
						wave: 0,
						pitchModSens: 0,
					},
				},
				[{ ampModSens: ams }],
			),
		);
		s.noteOn(69, 100);
		return s;
	};
	const none = renderMono(make(0), 1.5);
	const strong = renderMono(make(3), 1.5);
	const spread = (x: Float32Array): number => {
		const env: number[] = [];
		for (let i = 0; i < 14; i++)
			env.push(rms(x, Math.floor(RATE * (0.3 + i * 0.07)), Math.floor(RATE * (0.37 + i * 0.07))));
		return Math.max(...env) / Math.max(1e-9, Math.min(...env));
	};
	assert.ok(spread(strong) > spread(none) * 1.5, `${spread(strong)} vs ${spread(none)}`);
});

test('authentic mode runs the operators through the 12 bit log tables and stays close to the clean engine', () => {
	const render = (accuracy: 'clean' | 'authentic'): Float32Array => {
		const s = new Dx7Synth({ sampleRate: RATE, accuracy });
		s.loadVoice(voice({ algorithm: 4, feedback: 4 }, [{}, { levels: [99, 99, 99, 0], outputLevel: 80 }]));
		s.noteOn(60, 100);
		return renderMono(s, 0.8);
	};
	const clean = render('clean');
	const authentic = render('authentic');
	assert.notDeepEqual(clean, authentic);
	assert.ok(rms(authentic, 5000) > 0.01);
	const cmp = compareAudio(authentic, clean, { tolerance: 0.35, from: 5000, to: clean.length - 5000 });
	assert.ok(cmp.relativeError < 0.35, `difference to the clean engine ${cmp.relativeError}`);
});

test('single voice SysEx dump is parsed into the same fields as a bank voice', () => {
	const d = new Array<number>(155).fill(0);
	for (let o = 0; o < 6; o++) {
		const s = o * 21;
		d.splice(s, 4, 99, 90, 80, 70);
		d.splice(s + 4, 4, 99, 80, 60, 0);
		d[s + 13] = 3; // rate scaling
		d[s + 14] = 2; // amp mod sens
		d[s + 15] = 5; // key velocity sens
		d[s + 16] = 85 - o; // output level
		d[s + 17] = 0;
		d[s + 18] = 2; // coarse
		d[s + 19] = 7; // fine
		d[s + 20] = 9; // detune
	}
	d[134] = 21; // algorithm
	d[135] = 5; // feedback
	d[136] = 1; // oscillator key sync
	d[142] = 2; // lfo wave
	d[143] = 3; // pitch mod sens
	d.splice(145, 10, ...[...'INIT VOICE'].map((c) => c.charCodeAt(0)));
	const bytes = Uint8Array.from([0xf0, 0x43, 0x00, 0x00, 0x01, 0x1b, ...d, dx7Checksum(d), 0xf7]);
	const v = parseDx7Single(bytes);
	assert.equal(v.name, 'INIT VOICE');
	assert.equal(v.algorithm, 21);
	assert.equal(v.feedback, 5);
	assert.ok(v.oscKeySync);
	assert.equal(v.operators[0].outputLevel, 85);
	assert.equal(v.operators[5].outputLevel, 80);
	assert.equal(v.operators[0].freqCoarse, 2);
	assert.equal(v.operators[0].freqFine, 7);
	assert.equal(v.operators[0].detune, 9);
	assert.equal(v.operators[0].keyVelocitySens, 5);
	assert.equal(v.operators[0].ampModSens, 2);
	assert.equal(v.lfo.wave, 2);
	assert.equal(v.lfo.pitchModSens, 3);
	const bad = bytes.slice();
	bad[20] ^= 1;
	assert.throws(() => parseDx7Single(bad), /checksum/);
});

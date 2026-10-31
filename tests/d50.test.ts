import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	BreakPointEnvelope,
	D50_ATTACKS,
	D50_PRESETS,
	D50Synth,
	LowPass,
	renderAttackRecipe,
	synthAttackWave,
	type BreakPoints,
	type D50Attack,
	type D50Partial,
} from '../src/chips/historical.ts';
import { createChip } from '../src/chips/index.ts';
import { frequency, peak, renderMono, renderStereo, rms, RATE } from './util.ts';

const AMP: [number, number][] = [
	[0, 1],
	[1, 1],
];

test('D-50 (no ROM): registry id, built-in synthesized attack bank, presets by write(128)', () => {
	assert.equal(createChip('d50', { sampleRate: RATE }).id, 'd50');
	assert.ok(D50_ATTACKS.length >= 16, `${D50_ATTACKS.length} synthesized attacks`);
	assert.ok(D50_PRESETS.length >= 6);
	// the attack bank is generated, deterministic, finite and non-silent
	const a = synthAttackWave(0, RATE);
	assert.deepEqual(a, synthAttackWave(0, RATE));
	assert.ok(a.length > RATE / 4 && peak(a) > 0.1);
	assert.ok(a.every(Number.isFinite));
	assert.notDeepEqual(synthAttackWave(0, RATE), synthAttackWave(3, RATE));
	const s = new D50Synth({ sampleRate: RATE });
	s.write(128, 1);
	assert.equal(s.preset, 1);
	// presets are layered and detuned: the zero-crossing pitch check is made on a plain one-partial patch
	const plain = new D50Synth({ sampleRate: RATE });
	plain.loadPatch({ tones: [{ structure: 1, partials: [{ wave: 'saw', cutoff: 12000, amp: AMP }] }] });
	plain.noteOn(69, 127);
	assert.ok(Math.abs(frequency(renderMono(plain, 1), RATE, RATE / 4) - 440) < 2);
});

test('D-50: synth partial at pitch, ring structure differs from mixed structure', () => {
	const mk = (structure: number): D50Synth => {
		const s = new D50Synth({ sampleRate: RATE });
		s.loadPatch({
			tones: [
				{
					structure,
					partials: [
						{ wave: 'saw', cutoff: 12000, amp: AMP },
						{ wave: 'square', cutoff: 12000, amp: AMP },
					],
				},
			],
		});
		s.noteOn(57, 127);
		return s;
	};
	const mixed = renderMono(mk(1), 0.5);
	assert.ok(Math.abs(frequency(mixed, RATE, RATE / 4) - 220) < 2);
	assert.notDeepEqual(renderMono(mk(2), 0.2), mixed.subarray(0, Math.floor(RATE * 0.2)));
});

test('D-50: synthesized attack partial is a one-shot transient, user PCM can replace it', () => {
	const s = new D50Synth({ sampleRate: RATE });
	s.loadPatch({
		tones: [
			{
				structure: 1,
				partials: [
					{ wave: 'attack', attack: 0, cutoff: 18000, amp: AMP },
					{
						wave: 'saw',
						cutoff: 300,
						amp: [
							[0, 0],
							[1, 0],
						],
					},
				],
			},
		],
	});
	s.noteOn(69, 127);
	const out = renderMono(s, 2);
	assert.ok(rms(out, 0, 500) > 0.01, 'attack transient at the start (LA attacks are short: about 10 ms)');
	assert.ok(rms(out, out.length - 4000) < 1e-3, 'one-shot attack has ended while the key is held');
	// a user supplied PCM source still takes precedence over the built-in bank
	const sine = Float32Array.from({ length: 441 }, (_, i) => Math.sin((2 * Math.PI * i) / 441));
	const u = new D50Synth({ sampleRate: RATE });
	u.loadPatch({
		tones: [
			{
				structure: 1,
				partials: [
					{
						wave: 'attack',
						attack: 0,
						pcm: { data: sine, rate: RATE, rootNote: 69, loopStart: 0, loopEnd: 441 },
						cutoff: 18000,
						amp: AMP,
					},
					{
						wave: 'saw',
						cutoff: 300,
						amp: [
							[0, 0],
							[1, 0],
						],
					},
				],
			},
		],
	});
	u.noteOn(69, 127);
	const looped = renderMono(u, 1);
	assert.ok(rms(looped, looped.length - 4000) > 0.05, 'looped user PCM keeps sounding');
});

test('D-50: chorus decorrelates the stereo image, release ends the voice', () => {
	const mk = (chorus?: { mix: number }): D50Synth => {
		const s = new D50Synth({ sampleRate: RATE });
		s.loadPatch({
			chorus,
			tones: [
				{
					structure: 1,
					partials: [
						{ wave: 'saw', cutoff: 8000, amp: AMP },
						{ wave: 'saw', cutoff: 8000, amp: AMP, detuneCents: 6 },
					],
				},
			],
			release: 0.05,
		});
		s.noteOn(69, 127);
		return s;
	};
	const [l, r] = renderStereo(mk({ mix: 0.5 }), 0.5);
	assert.notDeepEqual(l, r, 'chorus makes left and right differ');
	const dry = renderStereo(mk(), 0.1);
	assert.deepEqual(dry[0], dry[1], 'no effect: mono centred');
	const one = mk();
	renderMono(one, 0.2);
	one.noteOff(69);
	const tail = renderMono(one, 0.5);
	assert.ok(rms(tail, tail.length - 4000) < 1e-4);
	assert.equal(one.activeVoices, 0);
});

test('D-50: every preset makes finite, audible sound with the fitted attack bank', () => {
	D50_PRESETS.forEach((p, i) => {
		const s = new D50Synth({ sampleRate: RATE });
		s.write(128, i);
		s.noteOn(60, 110);
		const out = renderMono(s, 0.6);
		assert.ok(out.every(Number.isFinite), p.name);
		assert.ok(rms(out, 2000, 20000) > 0.005, `${p.name} is audible`);
	});
});

test('LowPass: cached coefficients match direct calculation when cutoff, damping or rate changes', () => {
	const filter = new LowPass();
	let ic1 = 0;
	let ic2 = 0;
	for (let i = 0; i < 2048; i++) {
		const rate = i < 1024 ? 44100 : 48000;
		const cutoff = i < 512 ? 2000 : 4000 + (i % 7) * 100;
		const damping = i < 1536 ? 1.8 : 0.3;
		const x = Math.sin(i * 0.13);
		const g = Math.tan((Math.PI * Math.min(cutoff, rate * 0.45)) / rate);
		const a1 = 1 / (1 + g * (g + damping));
		const a2 = g * a1;
		const a3 = g * a2;
		const v3 = x - ic2;
		const v1 = a1 * ic1 + a2 * v3;
		const v2 = ic2 + a2 * ic1 + a3 * v3;
		ic1 = 2 * v1 - ic1;
		ic2 = 2 * v2 - ic2;
		assert.equal(filter.process(x, cutoff, damping, rate), v2);
	}
});

test('D-50: skipping initial silence preserves the chorus clock and additive output', () => {
	const silent = new D50Synth({ sampleRate: RATE });
	const reference = new D50Synth({ sampleRate: RATE });
	const patch = { chorus: { mix: 0.5 }, reverb: { mix: 0.3 }, tones: [] };
	silent.loadPatch(patch);
	reference.loadPatch(patch);
	// An empty voice forces the normal effect path for this block and is then removed.
	reference.noteOn(60);
	const l = new Float32Array(10003).fill(0.25);
	const r = new Float32Array(10003).fill(-0.25);
	silent.render(l, r, 3, 9997);
	assert.ok(l.every((x) => x === 0.25));
	assert.ok(r.every((x) => x === -0.25));
	reference.render(new Float32Array(9997), new Float32Array(9997), 0, 9997);
	const sounding = {
		...patch,
		tones: [{ partials: [{ wave: 'saw' as const, cutoff: 8000, amp: AMP }] }],
	};
	silent.loadPatch(sounding);
	reference.loadPatch(sounding);
	silent.noteOn(67);
	reference.noteOn(67);
	assert.deepEqual(renderStereo(silent, 0.1), renderStereo(reference, 0.1));
});

test('D-50: rendering in blocks preserves modulation, voice removal and effect tails', () => {
	const make = (): D50Synth => {
		const s = new D50Synth({ sampleRate: RATE });
		s.selectPreset(0);
		for (let n = 0; n < 16; n++) s.noteOn(48 + n);
		return s;
	};
	const whole = make();
	const blocks = make();
	function compare(count: number): void {
		const l = new Float32Array(count),
			r = new Float32Array(count);
		const expectedL = new Float32Array(count),
			expectedR = new Float32Array(count);
		whole.render(expectedL, expectedR, 0, count);
		for (let offset = 0; offset < count; offset += 128) {
			blocks.render(l, r, offset, Math.min(128, count - offset));
		}
		assert.deepEqual(l, expectedL);
		assert.deepEqual(r, expectedR);
	}
	compare(4097);
	for (let n = 0; n < 15; n++) {
		whole.noteOff(48 + n);
		blocks.noteOff(48 + n);
	}
	compare(RATE * 2);
	assert.equal(whole.activeVoices, 1);
	assert.equal(blocks.activeVoices, 1);
	whole.noteOff(63);
	blocks.noteOff(63);
	compare(RATE * 2);
	assert.equal(blocks.activeVoices, 0);
	compare(2048);
	whole.reset();
	blocks.reset();
	compare(2048);
});

test('break-point envelopes: segment tracking preserves boundaries, sustain, edits and backwards steps', () => {
	const shapes: BreakPoints[] = [
		[[0, 0.7]],
		[
			[0, 0],
			[0, 1],
			[0.02, 0.3],
			[0.02, 0.8],
			[0.04, 0.1],
		],
		[
			[0, 0.1],
			[0.01, 0.8],
			[0.02, 0.2],
			[0.03, 0.6],
			[0.04, 0.3],
		],
	];
	for (const shape of shapes) {
		for (const sustain of [0, 1, shape.length - 1]) {
			const points: [number, number][] = shape.map(([time, level]) => [time, level]);
			const envelope = new BreakPointEnvelope(points, sustain);
			let elapsed = 0;
			for (let step = 0; step < 600; step++) {
				if (step === 200) points[points.length - 1][1] = 0.123;
				const dt = step === 150 ? -0.04 : 0.0002;
				elapsed += dt;
				const t = Math.min(elapsed, points[Math.min(sustain, points.length - 1)][0]);
				const end = points.findIndex((point, i) => i > 0 && t <= point[0]);
				let expected = points[points.length - 1][1];
				if (end !== -1) {
					const [t0, v0] = points[end - 1];
					const [t1, v1] = points[end];
					expected = t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
				}
				assert.equal(envelope.next(dt), expected, `sustain ${sustain}, step ${step}`);
			}
		}
	}
});

test('D-50: cached attack recipes match fresh PCM, including edits, overlapping notes and sample rates', () => {
	const recipe: D50Attack = {
		name: 'Synthetic cache regression',
		harmonics: [
			[1, 1, 0.03],
			[2.1, 0.4, 0.01],
		],
		noise: 0.1,
		noiseDecay: 0.02,
		duration: 0.08,
	};
	for (const sampleRate of [44100, 48000, 44100]) {
		const cached = new D50Synth({ sampleRate });
		const fresh = new D50Synth({ sampleRate });
		const partial: D50Partial = { wave: 'attack', recipe, cutoff: 6000, amp: AMP };
		cached.loadPatch({ tones: [{ partials: [partial] }] });
		for (let note = 60; note < 64; note++) {
			if (note === 62) {
				recipe.harmonics = [
					[1.5, 0.7, 0.02],
					[3, 0.5, 0.04],
				];
				recipe.noise = 0.3;
				recipe.noiseDecay = 0.01;
				recipe.duration = 0.12;
			}
			fresh.loadPatch({
				tones: [
					{
						partials: [
							{
								...partial,
								recipe: undefined,
								pcm: {
									data: renderAttackRecipe(recipe, sampleRate, 440 * 2 ** (-9 / 12)),
									rate: sampleRate,
								},
							},
						],
					},
				],
			});
			cached.noteOn(note, 110);
			fresh.noteOn(note, 110);
			assert.deepEqual(renderStereo(cached, 0.01), renderStereo(fresh, 0.01));
		}
	}
});

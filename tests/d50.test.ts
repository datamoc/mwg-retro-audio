import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D50_ATTACKS, D50_PRESETS, D50Synth, synthAttackWave } from '../src/chips/historical.ts';
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

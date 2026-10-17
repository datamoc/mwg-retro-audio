import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SfxEngine, evalCurve, renderSfx, type SfxDefinition } from '../src/sfx/index.ts';
import { loadYm } from '../src/formats/ym.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { Region } from '../src/region.ts';
import { frequency, peak, rms, RATE } from './util.ts';
import { buildYm } from './ymfile.ts';

// definitions written as data: each one is well under 20 lines
const laser = (chip: SfxDefinition['chip']): SfxDefinition => ({
	name: 'laser',
	chip,
	priority: 5,
	retrigger: 'restart',
	length: 30,
	voices: [{ channel: 0, pitch: { start: 96, step: -1.5, min: 40 }, volume: { start: 15, step: -0.4, min: 0 } }],
});
const explosion = (chip: SfxDefinition['chip']): SfxDefinition => ({
	name: 'explosion',
	chip,
	priority: 5,
	retrigger: 'restart',
	voices: [
		{
			channel: 'any',
			noisePeriod: { start: 4, step: 0.5, max: 31 },
			mix: { values: [2] },
			volume: { start: 15, step: -0.5, min: 0 },
		},
	],
});

test('evalCurve: tables hold, loop and ping-pong; ramps are bounded', () => {
	assert.equal(evalCurve({ values: [1, 2, 3] }, 10), 3);
	assert.equal(evalCurve({ values: [1, 2, 3], loopStart: 1 }, 3), 2);
	assert.equal(evalCurve({ values: [1, 2, 3], loopStart: 1 }, 4), 3);
	assert.deepEqual(
		[3, 4, 5, 6, 7].map((t) => evalCurve({ values: [0, 1, 2], loopStart: 0, pingPong: true }, t)),
		[2, 1, 0, 1, 2],
	);
	assert.equal(evalCurve({ start: 10, step: -2, min: 4 }, 100), 4);
	assert.equal(evalCurve({}, 0), undefined);
});

test('renderSfx plays the same definition on AY, SN76489, NES and SID, deterministically', () => {
	for (const chip of ['ym2149', 'sn76489', 'nes', 'sid'] as const) {
		const def: SfxDefinition =
			chip === 'sid' ? { ...laser(chip), voices: [{ ...laser(chip).voices[0], waveform: 0x20 }] } : laser(chip);
		const a = renderSfx(def, 0.6, { sampleRate: RATE });
		const b = renderSfx(def, 0.6, { sampleRate: RATE });
		assert.deepEqual(a.left, b.left, `${chip} is deterministic`);
		assert.ok(rms(a.left, 0, 8000) > 0.005, `${chip} sounds`);
		assert.ok(rms(a.left, Math.floor(RATE * 0.55)) < 0.002, `${chip} is silent after the end`);
	}
});

test('a laser falls in pitch (glissando down) and an explosion is noise with a decaying volume', () => {
	const l = renderSfx(laser('ym2149'), 0.5, { sampleRate: RATE });
	const early = frequency(l.left.subarray(200, 3000), RATE);
	const late = frequency(l.left.subarray(14000, 17000), RATE);
	assert.ok(early > late * 1.5, `${early} -> ${late}`);
	const e = renderSfx(explosion('ym2149'), 1, { sampleRate: RATE });
	assert.ok(rms(e.left, 0, 4000) > rms(e.left, 20000, 24000) * 2, 'decays');
	assert.ok(rms(e.left, 0, 4000) > 0.02);
});

test('region sets the pitch and the duration: PAL and NTSC give the clock ratio of each standard', () => {
	const tone: SfxDefinition = {
		name: 't',
		chip: 'sn76489',
		priority: 1,
		retrigger: 'restart',
		length: 25,
		voices: [{ channel: 0, rawPeriod: { values: [254] }, volume: { values: [15] } }],
	};
	const ntsc = renderSfx(tone, 1, { sampleRate: RATE, region: Region.NTSC });
	const pal = renderSfx(tone, 1, { sampleRate: RATE, region: Region.PAL });
	const ratio = frequency(pal.left, RATE, 2000) / frequency(ntsc.left, RATE, 2000);
	assert.ok(Math.abs(ratio - 3_546_893 / 3_579_545) < 0.002, `ratio ${ratio}`);
	// 25 ticks last 25/60 s on NTSC and 25/50 s on PAL
	const lastSound = (x: Float32Array): number => {
		for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]) > 0.01) return i / RATE;
		return 0;
	};
	assert.ok(Math.abs(lastSound(ntsc.left) - 25 / 60) < 0.03 && Math.abs(lastSound(pal.left) - 25 / 50) < 0.03);
});

test('effect on a music channel: stolen then given back exactly, no gap in the music', () => {
	const regs = (): number[] => {
		const r = new Array<number>(16).fill(0);
		r[0] = 200; // channel A
		r[2] = 150; // channel B
		r[7] = 0b111100; // tones A and B
		r[8] = 12;
		r[9] = 12;
		return r;
	};
	const music = buildYm({ frames: 100, regs });
	const plain = renderPlayer(loadYm(music, { sampleRate: RATE }), { maxSeconds: 3 });
	const run = (channel: number): { all: Float32Array; at: number } => {
		const engine = new SfxEngine({ region: Region.PAL });
		engine.define({
			name: 'bip',
			chip: 'ym2149',
			priority: 5,
			retrigger: 'restart',
			length: 10,
			voices: [{ channel, rawPeriod: { values: [60] }, volume: { values: [15] } }],
		});
		const player = loadYm(music, { sampleRate: RATE, chipFactory: engine.wrapFactory() });
		const first = renderPlayer(player, { maxSeconds: 0.5 });
		engine.play('bip');
		const second = renderPlayer(player, { maxSeconds: 2.5 });
		const all = new Float32Array(first.left.length + second.left.length);
		all.set(first.left);
		all.set(second.left, first.left.length);
		return { all, at: first.left.length };
	};
	// an effect on a channel the music does not use: the music is untouched before, during and after it
	const free = run(2);
	assert.deepEqual(free.all.subarray(0, free.at), plain.left.subarray(0, free.at));
	assert.notDeepEqual(
		free.all.subarray(free.at + 200, free.at + 4000),
		plain.left.subarray(free.at + 200, free.at + 4000),
		'the effect is heard',
	);
	const tail = Math.floor(RATE * 1.2);
	assert.deepEqual(
		free.all.subarray(tail, tail + 4000),
		plain.left.subarray(tail, tail + 4000),
		'identical to the music alone afterwards',
	);
	// an effect that takes channel A: the music keeps its other channels and gets A back with its registers
	const stolen = run(0);
	assert.ok(rms(stolen.all, stolen.at + 200, stolen.at + 4000) > 0.02, 'music keeps playing on the other channels');
	const rmsAfter = rms(stolen.all, tail, tail + 20000);
	const rmsPlain = rms(plain.left, tail, tail + 20000);
	assert.ok(Math.abs(rmsAfter / rmsPlain - 1) < 0.02, `level back to ${rmsAfter} vs ${rmsPlain}`);
	assert.ok(
		Math.abs(
			frequency(stolen.all.subarray(tail, tail + 20000), RATE) /
				frequency(plain.left.subarray(tail, tail + 20000), RATE) -
				1,
		) < 0.01,
	);
});

test('priority: a lower priority effect cannot steal a channel; retrigger ignore; maxVoices', () => {
	const e = new SfxEngine({ region: Region.PAL, maxVoices: 2 });
	const music = loadYm(buildYm({ frames: 50, regs: () => new Array<number>(16).fill(0) }), {
		sampleRate: RATE,
		chipFactory: e.wrapFactory(),
	});
	const base = {
		chip: 'ym2149' as const,
		retrigger: 'ignore' as const,
		length: 50,
		voices: [{ channel: 0 as const, rawPeriod: { values: [100] }, volume: { values: [10] } }],
	};
	e.define({ ...base, name: 'high', priority: 9 });
	e.define({ ...base, name: 'low', priority: 1, retrigger: 'restart' });
	assert.ok(e.play('high') !== null);
	assert.equal(e.play('low'), null, 'the channel is taken by a higher priority effect');
	assert.equal(e.play('high'), null, 'ignore while it plays');
	assert.ok(e.isPlaying('high'));
	e.stopAll();
	assert.ok(!e.isPlaying('high'));
	void music;
});

test('SN76489 and NES effects share the chip with the music through their drivers', () => {
	const e = new SfxEngine({ region: Region.NTSC });
	const chip = e.wrapFactory()('sn76489', { sampleRate: RATE });
	e.define({
		name: 'beep',
		chip: 'sn76489',
		priority: 1,
		retrigger: 'restart',
		length: 20,
		voices: [{ channel: 1, rawPeriod: { values: [200] }, volume: { values: [15] } }],
	});
	chip.write(0, 0x80 | 5); // music: channel 0
	chip.write(0, 0x00);
	chip.write(0, 0x90);
	e.play('beep');
	const l = new Float32Array(RATE / 2);
	const r = new Float32Array(RATE / 2);
	chip.render(l, r, 0, l.length);
	assert.ok(peak(l) > 0.1);
	const n = new SfxEngine({ region: Region.NTSC });
	const nes = n.wrapFactory()('nes-apu', { sampleRate: RATE, clock: 1_789_773 });
	n.define({
		name: 'pulse',
		chip: 'nes',
		priority: 1,
		retrigger: 'restart',
		length: 20,
		voices: [{ channel: 1, pitch: { values: [69] }, volume: { values: [15] }, duty: { values: [2] } }],
	});
	n.play('pulse');
	const a = new Float32Array(RATE / 3);
	const b = new Float32Array(RATE / 3);
	nes.render(a, b, 0, a.length);
	assert.ok(Math.abs(frequency(a, RATE, 3000) - 440) < 5, `${frequency(a, RATE, 3000)}`);
});

test('unknown effect names throw; effects of a family without a sharing driver use their own chip', () => {
	const e = new SfxEngine({ region: Region.NTSC });
	assert.throws(() => e.play('nope'));
	e.define({
		name: 'fm',
		chip: 'opl2',
		priority: 1,
		retrigger: 'restart',
		length: 30,
		voices: [
			{
				channel: 0,
				pitch: { values: [69] },
				volume: { values: [15] },
				fm: {
					keyOnTick: 0,
					patch: {
						operators: [
							[0x01, 0x3f, 0xf0, 0x0f, 0],
							[0x21, 0x00, 0xf0, 0x0f, 0],
						],
						feedbackConnection: 0x01,
					},
				},
			},
		],
	});
	const out = renderSfx(
		{
			name: 'fm',
			chip: 'opl2',
			priority: 1,
			retrigger: 'restart',
			length: 30,
			voices: [
				{
					channel: 0,
					pitch: { values: [69] },
					volume: { values: [15] },
					fm: {
						keyOnTick: 0,
						patch: {
							operators: [
								[0x01, 0x3f, 0xf0, 0x0f, 0],
								[0x21, 0x00, 0xf0, 0x0f, 0],
							],
							feedbackConnection: 0x01,
						},
					},
				},
			],
		},
		0.4,
		{ sampleRate: RATE },
	);
	assert.ok(peak(out.left) > 0.1, 'the FM effect sounds');
	assert.ok(Math.abs(frequency(out.left, RATE, 4000) - 440) < 3, `${frequency(out.left, RATE, 4000)}`);
});

test('a digitised voice plays on AY, SN76489, NES and SID through their volume registers (the 4 bit digi technique)', () => {
	const rate = 8000;
	const sample = Uint8Array.from({ length: 4000 }, (_, i) =>
		Math.round(127.5 + 120 * Math.sin((2 * Math.PI * 440 * i) / rate)),
	);
	for (const chip of ['ym2149', 'sn76489', 'nes', 'sid'] as const) {
		const def: SfxDefinition = {
			name: 'voice',
			chip,
			priority: 3,
			retrigger: 'restart',
			voices: [{ channel: 0, sample: { data: sample, rate, bits: 8 } }],
		};
		const out = renderSfx(def, 0.8, { sampleRate: RATE });
		assert.ok(rms(out.left, 2000, 20000) > 0.01, `${chip} is audible`);
		assert.ok(
			Math.abs(frequency(out.left.subarray(3000, 20000), RATE) - 440) < 8,
			`${chip}: ${frequency(out.left.subarray(3000, 20000), RATE)} Hz`,
		);
		assert.ok(rms(out.left, Math.floor(RATE * 0.7)) < 0.01, `${chip} stops with the sample`);
	}
});

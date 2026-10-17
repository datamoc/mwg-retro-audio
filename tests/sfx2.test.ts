import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	SfxEngine,
	SoundtrackPlayer,
	importSfx,
	renderSfx,
	renderSoundtrack,
	type SfxDefinition,
	type SoundtrackProject,
} from '../src/sfx/index.ts';
import { MwaRecorder } from '../src/formats/index.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { loadFile } from '../src/formats/load.ts';
import { Region } from '../src/region.ts';
import { rms, RATE } from './util.ts';
import { buildYm } from './ymfile.ts';

const effects: Record<string, SfxDefinition> = {
	ym2149: {
		name: 'e',
		chip: 'ym2149',
		priority: 5,
		retrigger: 'restart',
		length: 30,
		voices: [{ channel: 0, pitch: { start: 90, step: -1.2, min: 40 }, volume: { start: 15, step: -0.5, min: 0 } }],
	},
	sn76489: {
		name: 'e',
		chip: 'sn76489',
		priority: 5,
		retrigger: 'restart',
		length: 30,
		voices: [{ channel: 1, pitch: { start: 84, step: -1, min: 40 }, volume: { start: 15, step: -0.5, min: 0 } }],
	},
	nes: {
		name: 'e',
		chip: 'nes',
		priority: 5,
		retrigger: 'restart',
		length: 30,
		voices: [
			{
				channel: 0,
				pitch: { start: 84, step: -1, min: 40 },
				volume: { start: 15, step: -0.5, min: 0 },
				duty: { values: [2] },
			},
		],
	},
};

test('import: an effect recorded from the chip registers is rebuilt and replays the same audio (AY, SN76489, NES)', () => {
	for (const [family, def] of Object.entries(effects)) {
		const original = renderSfx(def, 0.7, { sampleRate: RATE, region: Region.NTSC });
		// record what the effect writes to the chip
		const rec = new MwaRecorder();
		const engine = new SfxEngine({ region: Region.NTSC, sampleRate: RATE });
		const clock = family === 'ym2149' ? 2_000_000 : family === 'sn76489' ? 3_579_545 : 1_789_773;
		const guard = engine.attach(rec.factory(family === 'nes' ? 'nes-apu' : family, { sampleRate: RATE, clock }));
		engine.define(def);
		engine.play('e');
		const l = new Float32Array(Math.floor(0.7 * RATE));
		const r = new Float32Array(l.length);
		guard.render(l, r, 0, l.length);
		const data = rec.finish({ frameRate: 60 });
		const imported = importSfx(data, { name: 'e' });
		assert.equal(imported.chip, family);
		assert.ok(imported.length! >= 25 && imported.length! <= 40, `${family}: ${imported.length} ticks`);
		const again = renderSfx(imported, 0.7, { sampleRate: RATE, region: Region.NTSC });
		let diff = 0;
		let energy = 0;
		for (let i = 0; i < l.length; i++) {
			diff += (again.left[i] - original.left[i]) ** 2;
			energy += original.left[i] ** 2;
		}
		assert.ok(energy > 0, `${family} makes sound`);
		assert.ok(diff / energy < 0.02, `${family}: relative error ${diff / energy}`);
	}
});

test('import refuses a recording without a supported chip or without sound', () => {
	const rec = new MwaRecorder();
	rec.factory('opl2', { sampleRate: RATE });
	assert.throws(() => importSfx(rec.finish({ frameRate: 60 }), { name: 'x' }), /no chip of a supported family/);
	const silent = new MwaRecorder();
	const chip = silent.factory('ym2149', { sampleRate: RATE, clock: 2_000_000 });
	chip.write(7, 0xff);
	chip.render(new Float32Array(2000), new Float32Array(2000), 0, 2000);
	assert.throws(() => importSfx(silent.finish({ frameRate: 50 }), { name: 'x' }), /silent/);
});

test('ducking lowers the music on the channels the effect does not use, only while it plays', () => {
	const regs = (): number[] => {
		const r = new Array<number>(16).fill(0);
		r[0] = 200;
		r[2] = 150;
		r[7] = 0b111100;
		r[8] = 12;
		r[9] = 12;
		return r;
	};
	const music = buildYm({ frames: 150, regs });
	const run = (duck: number): Float32Array => {
		const engine = new SfxEngine({ region: Region.PAL, sampleRate: RATE });
		engine.duck = duck;
		engine.define({
			name: 'bip',
			chip: 'ym2149',
			priority: 5,
			retrigger: 'restart',
			length: 25,
			voices: [{ channel: 2, rawPeriod: { values: [60] }, volume: { values: [3] } }],
		});
		const player = loadFile(music, { sampleRate: RATE, chipFactory: engine.wrapFactory() });
		const a = renderPlayer(player, { maxSeconds: 0.5 }).left;
		engine.play('bip');
		const b = renderPlayer(player, { maxSeconds: 2.5 }).left;
		const all = new Float32Array(a.length + b.length);
		all.set(a);
		all.set(b, a.length);
		return all;
	};
	const plain = run(1);
	const ducked = run(0.25);
	const during = (x: Float32Array): number => rms(x, Math.floor(RATE * 0.55), Math.floor(RATE * 0.9));
	const after = (x: Float32Array): number => rms(x, Math.floor(RATE * 1.4), Math.floor(RATE * 1.9));
	const before = (x: Float32Array): number => rms(x, Math.floor(RATE * 0.1), Math.floor(RATE * 0.4));
	assert.ok(during(ducked) < during(plain) * 0.8, `during: ${during(ducked)} vs ${during(plain)}`);
	assert.ok(Math.abs(after(ducked) / after(plain) - 1) < 0.02, 'music back at full level afterwards');
	assert.ok(Math.abs(before(ducked) / before(plain) - 1) < 0.001, 'untouched before the effect');
});

test('soundtrack project: commands start music and effects, offline rendering follows the timeline', async () => {
	const song = buildYm({ frames: 400, regs: () => [100, 0, 0, 0, 0, 0, 0, 0b111110, 10, 0, 0, 0, 0, 0, 0, 0] });
	const project: SoundtrackProject = {
		name: 'game',
		region: 'PAL',
		music: { title: 'title.ym' },
		bank: {
			name: 'sfx',
			region: 'PAL',
			effects: [{ ...effects.ym2149, name: 'laser', voices: [{ ...effects.ym2149.voices[0], channel: 2 }] }],
		},
		triggers: { 1: { kind: 'music', id: 'title' }, 7: { kind: 'sfx', id: 'laser' } },
	};
	const options = { sampleRate: RATE, load: async (p: string) => (p === 'title.ym' ? song : new Uint8Array(0)) };
	const out = await renderSoundtrack(
		project,
		[
			{ at: 0, command: 1 },
			{ at: 1, command: 7 },
			{ at: 1.5, command: 99 },
		],
		3,
		options,
	);
	assert.equal(out.left.length, 3 * RATE);
	assert.ok(rms(out.left, 1000, 40000) > 0.02, 'music from the first command');
	const sp = new SoundtrackPlayer(project, options);
	await sp.load();
	assert.equal(sp.trigger(99), false, 'unknown command');
	assert.equal(sp.trigger(1), true);
	assert.equal(sp.playing, 'title');
	assert.throws(() => sp.playMusic('missing'));
	// the laser changes the sound while it plays
	const plain = await renderSoundtrack(project, [{ at: 0, command: 1 }], 3, options);
	assert.notDeepEqual(
		out.left.subarray(Math.floor(RATE * 1.05), Math.floor(RATE * 1.4)),
		plain.left.subarray(Math.floor(RATE * 1.05), Math.floor(RATE * 1.4)),
	);
	assert.deepEqual(out.left.subarray(0, RATE), plain.left.subarray(0, RATE), 'identical before the effect');
});

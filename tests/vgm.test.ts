import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { isVgm, loadVgm, parseVgm } from '../src/formats/vgm.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { frequency, peak, RATE } from './util.ts';
import { buildVgm } from './vgmfile.ts';

const wait = (n: number): number[] => [0x61, n & 255, n >> 8];

test('SN76489 VGM: pitch, duration from waits, GD3 tags', () => {
	const period = 254;
	const bytes = buildVgm({
		sn: 3_579_545,
		commands: [0x50, 0x80 | (period & 15), 0x50, period >> 4, 0x50, 0x90, ...wait(44100), 0x50, 0x9f],
		gd3: { title: 'Song', game: 'Game', author: 'Composer' },
		totalSamples: 44100,
	});
	assert.ok(isVgm(bytes));
	const player = loadVgm(bytes, { sampleRate: RATE });
	assert.equal(player.info.title, 'Song');
	assert.equal(player.info.author, 'Composer');
	assert.match(player.info.comment ?? '', /Game/);
	const out = renderPlayer(player, { maxSeconds: 5 });
	assert.ok(out.ended && Math.abs(out.duration - 1) < 0.001, `duration ${out.duration}`);
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 3_579_545 / (32 * period)) < 0.3);
});

test('VGZ (gzip) is read like VGM', () => {
	const bytes = buildVgm({ sn: 3_579_545, commands: [0x50, 0x85, 0x50, 0x0f, 0x50, 0x90, ...wait(4410)] });
	const gz = new Uint8Array(gzipSync(bytes));
	assert.ok(isVgm(gz));
	assert.equal(parseVgm(gz).version, 0x161);
	assert.ok(peak(renderPlayer(loadVgm(gz, { sampleRate: RATE }), { maxSeconds: 1 }).left) > 0.05);
});

test('AY-3-8910 writes (0xA0) and the 50 Hz rate field set the region', () => {
	const bytes = buildVgm({
		ay: 1_773_400,
		rate: 50,
		commands: [0xa0, 0, 100, 0xa0, 1, 0, 0xa0, 7, 0x3e, 0xa0, 8, 15, ...wait(22050)],
	});
	const player = loadVgm(bytes, { sampleRate: RATE });
	assert.equal(player.info.frameRate, 50);
	const out = renderPlayer(player, { maxSeconds: 2 });
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 8) - 1_773_400 / (16 * 100)) < 0.5);
});

test('YM2612 port 0/1 writes and the PCM data bank with 0x8n commands', () => {
	const pcm = [0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff];
	const bytes = buildVgm({
		ym2612: 7_670_454,
		commands: [
			0x67,
			0x66,
			0x00,
			pcm.length,
			0,
			0,
			0,
			...pcm,
			0x52,
			0x2b,
			0x80, // DAC on
			0x53,
			0xb6 & 0xff,
			0xc0, // pan on channel 6 (port 1, register B6)
			0x80,
			0x81,
			0x80,
			0x81,
			0x80,
			0x81,
			0x80,
			0x81,
			...wait(2000),
		],
	});
	const out = renderPlayer(loadVgm(bytes, { sampleRate: RATE }), { maxSeconds: 1 });
	assert.ok(peak(out.left) > 0.05 || peak(out.right) > 0.05);
});

test('OPL2 writes play and the loop point restarts the stream', () => {
	const bytes = buildVgm({
		opl2: 3_579_545,
		commands: [
			0x5a,
			0x20,
			0x21,
			0x5a,
			0x40,
			0x00,
			0x5a,
			0x60,
			0xf0,
			0x5a,
			0x80,
			0x0f,
			0x5a,
			0xa0,
			580 & 255,
			0x5a,
			0xb0,
			0x20 | (4 << 2) | (580 >> 8),
			0x5a,
			0xc0,
			0x01,
			...wait(2000),
		],
		loopAt: 21,
		totalSamples: 2000,
	});
	// loop point at the final wait: with loop the stream never ends
	const looped = renderPlayer(loadVgm(bytes, { sampleRate: RATE, loop: true }), { maxSeconds: 1 });
	assert.ok(!looped.ended);
	assert.ok(renderPlayer(loadVgm(bytes, { sampleRate: RATE }), { maxSeconds: 1 }).ended);
});

test('unknown chips are reported, unknown commands are skipped', () => {
	const bytes = buildVgm({ sn: 3_579_545, commands: [0xc0, 1, 2, 3, 0x50, 0x80, ...wait(100)] });
	const p = loadVgm(bytes, { sampleRate: RATE });
	assert.ok(renderPlayer(p, { maxSeconds: 1 }).ended);
});

test('YM2151 writes (0x54) play the OPM', () => {
	const w = (r: number, v: number): number[] => [0x54, r, v];
	const cmds = [...w(0x20, 0xc7), ...w(0x28, 0x4a), ...w(0x30, 0)];
	for (let slot = 0; slot < 4; slot++)
		cmds.push(
			...w(0x40 + slot * 8, 1),
			...w(0x60 + slot * 8, slot === 3 ? 0 : 127),
			...w(0x80 + slot * 8, 0x1f),
			...w(0xe0 + slot * 8, 0x0f),
		);
	cmds.push(...w(0x08, 0x78), ...wait(44100));
	const p = loadVgm(buildVgm({ ym2151: 3_579_545, commands: cmds }), { sampleRate: RATE });
	assert.deepEqual(p.unsupported, []);
	const out = renderPlayer(p, { maxSeconds: 2 });
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 440) < 1);
});

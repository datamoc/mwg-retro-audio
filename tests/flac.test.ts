import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFlac, md5 } from '../src/driver/flac.ts';
import { decodeFlac } from './flacdecode.ts';

const RATE = 44100;
const make = (n: number, f: (i: number) => [number, number]): [Float32Array, Float32Array] => {
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	for (let i = 0; i < n; i++) [l[i], r[i]] = f(i);
	return [l, r];
};
let seed = 11;
const noise = (): number => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 31 - 1;
};
const ints = (l: Float32Array, r: Float32Array, bps: number): number[] => {
	const max = 2 ** (bps - 1) - 1;
	const q = (x: number): number => Math.max(-max - 1, Math.min(max, Math.round(x * max))) + 0; // + 0 turns -0 into 0
	return Array.from(l, (v, i) => [q(v), q(r[i])]).flat();
};

const CASES: Record<string, () => [Float32Array, Float32Array]> = {
	sine: () => make(RATE, (i) => [0.5 * Math.sin(i * 0.05), 0.4 * Math.sin(i * 0.05 + 1)]),
	silence: () => make(9000, () => [0, 0]),
	mono: () => make(RATE / 2, (i) => [0.6 * Math.sin(i * 0.02), 0.6 * Math.sin(i * 0.02)]),
	noise: () => make(RATE / 2, () => [noise() * 0.9, noise() * 0.9]),
	short: () => make(1000, (i) => [Math.sin(i * 0.3) * 0.7, Math.cos(i * 0.1) * 0.5]),
	tiny: () => make(5, (i) => [i / 10, -i / 10]),
	square: () => make(RATE / 2, (i) => [i % 200 < 100 ? 1 : -1, i % 150 < 75 ? -1 : 1]),
	ragged: () => make(4096 * 3 + 123, (i) => [0.3 * Math.sin(i * 0.011) + 0.1 * noise(), 0.3 * Math.sin(i * 0.013)]),
	clipped: () => make(3000, (i) => [Math.sin(i * 0.01) * 3, -Math.sin(i * 0.01) * 3]),
};

test('md5 matches node:crypto on many lengths', () => {
	for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 4097]) {
		const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
		assert.equal(
			Buffer.from(md5(data)).toString('hex'),
			createHash('md5').update(data).digest('hex'),
			`length ${n}`,
		);
	}
});

test('FLAC: every case decodes back to the exact quantised samples, with valid CRCs and MD5, at 16 and 24 bits', () => {
	for (const [name, build] of Object.entries(CASES)) {
		const [l, r] = build();
		for (const bps of [16, 24] as const) {
			const file = encodeFlac(l, r, RATE, { bitsPerSample: bps });
			const d = decodeFlac(file);
			assert.equal(d.sampleRate, RATE, name);
			assert.equal(d.channels, 2, name);
			assert.equal(d.bitsPerSample, bps, name);
			assert.equal(d.totalSamples, l.length, name);
			assert.ok(d.md5Matches, `${name} ${bps}: MD5 of the decoded audio matches STREAMINFO`);
			assert.deepEqual(Array.from(d.samples), ints(l, r, bps), `${name} ${bps}: exact round trip`);
		}
	}
});

test('FLAC: it compresses tonal audio, keeps silence tiny, and writes the tags and the block sizes', () => {
	const [l, r] = CASES.sine();
	const wav = l.length * 4;
	const flac = encodeFlac(l, r, RATE, { tags: { title: 'Test', artist: 'mwg' } });
	assert.ok(flac.length < wav * 0.4, `sine: ${flac.length} bytes of ${wav}`);
	const [sl, sr] = CASES.silence();
	assert.ok(encodeFlac(sl, sr, RATE).length < 400, 'silence is a handful of constant subframes');
	const d = decodeFlac(flac);
	assert.ok(d.comments.includes('TITLE=Test') && d.comments.includes('ARTIST=mwg'));
	assert.deepEqual([...new Set(d.blockSizes.slice(0, -1))], [4096]);
	assert.deepEqual(decodeFlac(encodeFlac(l, r, RATE, { blockSize: 1152 })).blockSizes.slice(0, 2), [1152, 1152]);
});

test('FLAC: bad arguments are refused', () => {
	const [l, r] = CASES.tiny();
	assert.throws(() => encodeFlac(l, r, RATE, { bitsPerSample: 20 as 16 }), RangeError);
	assert.throws(() => encodeFlac(l, r, RATE, { blockSize: 100 }), RangeError);
	assert.throws(() => encodeFlac(l, new Float32Array(3), RATE), RangeError);
	assert.throws(() => encodeFlac(l, r, 0), RangeError);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('FLAC: ffmpeg decodes our files bit for bit (skipped without ffmpeg)', { skip: !hasFfmpeg }, () => {
	const dir = mkdtempSync(join(tmpdir(), 'mw-flac-'));
	try {
		for (const name of ['sine', 'noise', 'ragged', 'square']) {
			const [l, r] = CASES[name]();
			for (const bps of [16, 24] as const) {
				const file = join(dir, `${name}${bps}.flac`);
				writeFileSync(file, encodeFlac(l, r, RATE, { bitsPerSample: bps }));
				const p = spawnSync(
					'ffmpeg',
					[
						'-v',
						'error',
						'-err_detect',
						'explode+crccheck',
						'-i',
						file,
						'-f',
						bps === 16 ? 's16le' : 's32le',
						'-',
					],
					{
						maxBuffer: 1 << 28,
					},
				);
				assert.equal(p.status, 0, `${name} ${bps}: ${p.stderr}`);
				const pcm = p.stdout;
				const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
				const got = Array.from({ length: pcm.length / (bps === 16 ? 2 : 4) }, (_, i) =>
					bps === 16 ? view.getInt16(i * 2, true) : view.getInt32(i * 4, true) >> 8,
				);
				assert.deepEqual(got, ints(l, r, bps), `${name} ${bps}`);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

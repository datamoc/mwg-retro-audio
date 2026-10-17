import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '../src/driver/Renderer.ts';
import { muxOggOpus, oggCrc } from '../src/driver/ogg.ts';
import { encodeOpus, isOpusEncodingAvailable, type OpusPacketEncoder } from '../src/driver/opus.ts';
import { resampleChannel } from '../src/driver/resample.ts';
import { parseOgg } from './oggparse.ts';
import { frequency, peak } from './util.ts';

/** fake Opus packets: not decodable, but their sizes exercise the lacing (0, 1, 254, 255, 256, 600 and 40 bytes) */
const fakePackets = (count: number): Uint8Array[] =>
	Array.from({ length: count }, (_, i) =>
		Uint8Array.from({ length: [0, 1, 254, 255, 256, 600, 40][i % 7] }, (_, k) => (i + k) & 0xff),
	);

test('Ogg Opus muxer: header pages, lacing, granule positions, trimmed last page, valid CRCs', () => {
	const packets = fakePackets(120);
	const bytes = muxOggOpus(packets, {
		channels: 2,
		inputSampleRate: 44100,
		preSkip: 312,
		totalSamples: 120 * 960 - 500,
		samplesPerPacket: 960,
		tags: { title: 'Étude', artist: 'mwg' },
	});
	const pages = parseOgg(bytes);
	assert.ok(
		pages.every((p) => p.crcOk),
		'every page CRC verifies',
	);
	assert.deepEqual(
		pages.map((p) => p.sequence),
		pages.map((_, i) => i),
		'page sequence numbers count up',
	);
	assert.equal(new Set(pages.map((p) => p.serial)).size, 1);
	assert.equal(pages[0].type, 0x02, 'first page is BOS');
	assert.equal(pages[pages.length - 1].type & 0x04, 0x04, 'last page is EOS');
	const head = pages[0].packets[0];
	assert.equal(String.fromCharCode(...head.subarray(0, 8)), 'OpusHead');
	const hv = new DataView(head.buffer, head.byteOffset);
	assert.deepEqual(
		[head[8], head[9], hv.getUint16(10, true), hv.getUint32(12, true), head[18]],
		[1, 2, 312, 44100, 0],
	);
	const tags = pages[1].packets[0];
	assert.equal(String.fromCharCode(...tags.subarray(0, 8)), 'OpusTags');
	assert.ok(new TextDecoder().decode(tags).includes('TITLE=Étude'));
	const audio = pages.slice(2).flatMap((p) => p.packets);
	assert.equal(audio.length, packets.length);
	audio.forEach((p, i) => assert.deepEqual(Array.from(p), Array.from(packets[i]), `packet ${i}`));
	const grans = pages.slice(2).map((p) => p.granule);
	assert.ok(grans.every((g, i) => i === 0 || g > grans[i - 1]));
	assert.equal(grans[grans.length - 1], 312 + 120 * 960 - 500);
	assert.equal(grans[0], 48 * 960, 'RFC 7845: granule positions count from the stream start, pre-skip included');
});

test('Ogg Opus muxer: per-packet sample counts, an empty stream, and the CRC of a known string', () => {
	const bytes = muxOggOpus(fakePackets(3), {
		channels: 2,
		inputSampleRate: 48000,
		preSkip: 100,
		totalSamples: 5000,
		samplesPerPacket: [960, 1920, 480],
	});
	assert.equal(parseOgg(bytes).at(-1)!.granule, 3360, 'never past the samples the packets hold');
	const empty = parseOgg(
		muxOggOpus([], { channels: 2, inputSampleRate: 48000, preSkip: 100, totalSamples: 0, samplesPerPacket: 960 }),
	);
	assert.ok(empty.every((p) => p.crcOk));
	assert.equal(empty.at(-1)!.type & 0x04, 0x04);
	// CRC-32/MPEG-2 without the final xor over "123456789" (the Ogg CRC) is 0x89A1897F
	assert.equal(oggCrc(new TextEncoder().encode('123456789')), 0x89a1897f);
});

test('Opus export: without WebCodecs or an encoder it fails with a message that says what to do', async () => {
	if (await isOpusEncodingAvailable()) return; // a browser-like environment: nothing to check here
	const l = new Float32Array(4800);
	await assert.rejects(encodeOpus(l, l, 48000), /WebCodecs|encoder/);
});

test('Opus export: a supplied encoder gets 48 kHz audio, its packets are muxed and the length is the real one', async () => {
	let seen = 0;
	const encoder: OpusPacketEncoder = async (l, r, progress) => {
		seen = l.length;
		assert.equal(l.length, r.length);
		progress?.(1);
		return { packets: fakePackets(Math.ceil((l.length + 312) / 960)), samplesPerPacket: 960, preSkip: 312 };
	};
	const progress: number[] = [];
	const l = new Float32Array(44100).fill(0.1);
	const bytes = await encodeOpus(l, l, 44100, { encoder, onProgress: (f) => progress.push(f), tags: { title: 'x' } });
	assert.equal(seen, 48000, '1 s at 44.1 kHz is 48 000 frames at 48 kHz');
	assert.deepEqual(progress, [1]);
	const pages = parseOgg(bytes);
	assert.equal(pages.at(-1)!.granule, 312 + 48000);
	assert.ok(pages.every((p) => p.crcOk));
	await assert.rejects(encodeOpus(l, new Float32Array(3), 44100, { encoder }), RangeError);
});

test('resampler: pitch, level, length and timing survive 44.1 -> 48 kHz and back', () => {
	const n = 44100;
	const tone = Float32Array.from({ length: n }, (_, i) => 0.6 * Math.sin((2 * Math.PI * 1000 * i) / 44100));
	const up = resampleChannel(tone, 44100, 48000);
	assert.equal(up.length, 48000);
	assert.ok(Math.abs(frequency(up, 48000, 4800) - 1000) < 2, 'same pitch');
	assert.ok(Math.abs(peak(up, 100) - 0.6) < 0.01, 'same level');
	// the output at 48 kHz equals the tone evaluated at the new sample times: no delay
	let worst = 0;
	for (let i = 200; i < 47800; i++)
		worst = Math.max(worst, Math.abs(up[i] - 0.6 * Math.sin((2 * Math.PI * 1000 * i) / 48000)));
	assert.ok(worst < 0.003, `worst deviation ${worst}`);
	const down = resampleChannel(up, 48000, 44100);
	assert.equal(down.length, 44100);
	let back = 0;
	for (let i = 200; i < 43900; i++) back = Math.max(back, Math.abs(down[i] - tone[i]));
	assert.ok(back < 0.005, `round trip ${back}`);
	// the band up to about 20 kHz is kept when going up (a tone at 18 kHz within 0.5 dB, at 20 kHz within 2 dB)
	for (const [hz, tol] of [
		[18000, 0.06],
		[20000, 0.21],
	] as const) {
		const t = Float32Array.from({ length: 44100 }, (_, i) => Math.sin((2 * Math.PI * hz * i) / 44100));
		const out = resampleChannel(t, 44100, 48000);
		assert.ok(Math.abs(peak(out.subarray(400, out.length - 400)) - 1) < tol, `${hz} Hz keeps its level`);
	}
	// a tone far above the new Nyquist frequency is removed when going down, not folded back
	const high = Float32Array.from({ length: 96000 }, (_, i) => Math.sin((2 * Math.PI * 30000 * i) / 96000));
	const folded = resampleChannel(high, 96000, 44100);
	assert.ok(peak(folded.subarray(400, folded.length - 400)) < 0.01, 'aliasing is suppressed');
	assert.equal(resampleChannel(tone, 44100, 44100), tone);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test(
	'Opus export: real libopus packets re-muxed by us decode in ffmpeg to the same audio (skipped without ffmpeg)',
	{ skip: !hasFfmpeg },
	() => {
		const dir = mkdtempSync(join(tmpdir(), 'mw-opus-'));
		try {
			const n = 48000 * 2 + 777;
			const left = Float32Array.from(
				{ length: n },
				(_, i) => 0.4 * Math.sin(i * 0.05) + 0.2 * Math.sin(i * 0.31),
			);
			const right = Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin(i * 0.07));
			writeFileSync(join(dir, 'in.wav'), encodeWav(left, right, 48000));
			const enc = spawnSync('ffmpeg', [
				'-v',
				'error',
				'-y',
				'-i',
				join(dir, 'in.wav'),
				'-c:a',
				'libopus',
				'-b:a',
				'96k',
				'-f',
				'ogg',
				join(dir, 'ref.opus'),
			]);
			assert.equal(enc.status, 0, String(enc.stderr));
			const ref = parseOgg(new Uint8Array(readFileSync(join(dir, 'ref.opus'))));
			const head = ref[0].packets[0];
			const preSkip = new DataView(head.buffer, head.byteOffset).getUint16(10, true);
			const packets = ref.slice(2).flatMap((p) => p.packets);
			const total = ref.at(-1)!.granule - preSkip;
			const ours = muxOggOpus(packets, {
				channels: 2,
				inputSampleRate: 48000,
				preSkip,
				totalSamples: total,
				samplesPerPacket: 960,
			});
			writeFileSync(join(dir, 'ours.opus'), ours);
			const decode = (f: string): Buffer => {
				const p = spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, f), '-f', 'f32le', '-'], {
					maxBuffer: 1 << 28,
				});
				assert.equal(p.status, 0, `${f}: ${p.stderr}`);
				return p.stdout;
			};
			const a = decode('ref.opus');
			const b = decode('ours.opus');
			assert.ok(a.equals(b), 'identical decoded audio');
			assert.equal(
				b.length / 8,
				n,
				'decoded length is the exact input length (the end is trimmed by the granule position)',
			);
			const probe = spawnSync('ffprobe', [
				'-v',
				'error',
				'-show_entries',
				'stream=codec_name,channels,sample_rate',
				'-of',
				'default=nw=1',
				join(dir, 'ours.opus'),
			]);
			assert.match(String(probe.stdout), /codec_name=opus[\s\S]*channels=2/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

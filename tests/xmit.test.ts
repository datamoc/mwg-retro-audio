import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isXm, loadXm, parseXm } from '../src/formats/tracker/xm.ts';
import { isIt, loadIt, parseIt } from '../src/formats/tracker/it.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { frequency, peak, rms, RATE } from './util.ts';
import { buildIt, buildXm } from './xmitfile.ts';

// the test sample is a 32 sample looped square: output frequency = playback rate / 32

test('XM header, pattern and instrument are parsed', () => {
	const bytes = buildXm({ rows: [[{ note: 49, instrument: 1 }]] });
	assert.ok(isXm(bytes));
	const song = parseXm(bytes);
	assert.equal(song.channels, 2);
	assert.equal(song.linear, true);
	assert.equal(song.patterns[0].cells[0][0].note, 49);
	assert.equal(song.instruments[0].samples[0].data.length, 32);
	assert.equal(Math.round(song.instruments[0].samples[0].data[0] * 128), 100, 'delta decoding');
});

test('XM linear frequencies: C-4 plays the sample at 8363 Hz, an octave higher doubles it, relative note shifts it', () => {
	const f = (note: number, extra = {}): number =>
		frequency(
			renderPlayer(loadXm(buildXm({ rows: [[{ note, instrument: 1 }]], ...extra }), { sampleRate: RATE }), {
				maxSeconds: 1,
			}).left,
			RATE,
			RATE / 4,
		);
	assert.ok(Math.abs(f(49) - 8363 / 32) < 0.5, `${f(49)}`);
	assert.ok(Math.abs(f(61) / f(49) - 2) < 0.01);
	assert.ok(Math.abs(f(49, { relativeNote: 12 }) / f(49) - 2) < 0.01);
	assert.ok(Math.abs(f(49, { finetune: 64 }) / f(49) - 2 ** (0.5 / 12)) < 0.002, 'finetune of half a semitone');
});

test('XM Amiga frequency table is used when the linear flag is off', () => {
	const out = renderPlayer(
		loadXm(buildXm({ rows: [[{ note: 49, instrument: 1 }]], linear: false }), { sampleRate: RATE }),
		{ maxSeconds: 1 },
	);
	// period 6848 / 16 = 428 -> 7093789.2 / 856 = 8287 Hz
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 8287 / 32) < 3, `${frequency(out.left, RATE)}`);
});

test('XM volume column, key off with fadeout and volume envelope', () => {
	const run = (rows: object[][], extra = {}): Float32Array =>
		renderPlayer(loadXm(buildXm({ rows: rows as never, ...extra }), { sampleRate: RATE }), { maxSeconds: 2 }).left;
	const full = run([[{ note: 49, instrument: 1 }]]);
	const half = run([[{ note: 49, instrument: 1, volume: 0x10 + 32 }]]);
	assert.ok(Math.abs(peak(half) / peak(full) - 0.5) < 0.02);
	// key off (97) with a fadeout: the sound dies out
	const rows = Array.from({ length: 16 }, () => [{}]);
	rows[0] = [{ note: 49, instrument: 1 }];
	rows[2] = [{ note: 97 }];
	const faded = run(rows, { fadeout: 4000, patternRows: 16 });
	assert.ok(rms(faded, 0, 4000) > 0.05);
	assert.ok(rms(faded, 70000, 80000) < 0.005, 'silent after the fadeout');
	// volume envelope: 0 -> 64 -> 0 over 48 ticks
	const env = run([[{ note: 49, instrument: 1 }]], {
		volEnv: {
			points: [
				[0, 0],
				[24, 64],
				[48, 0],
			],
			flags: 1,
		},
	});
	assert.ok(
		rms(env, 8000, 12000) > 0 && rms(env, 20000, 24000) > rms(env, 1000, 3000) * 1.5,
		'rises with the envelope',
	);
});

test('XM effects: speed F, pattern break D (BCD), global volume G', () => {
	const rows = Array.from({ length: 8 }, () => [{}]);
	rows[0] = [{ note: 49, instrument: 1, effect: 0xf, param: 3 }];
	rows[1] = [{ effect: 0xd, param: 0x01 }]; // break to row 1 of the next pattern = end
	const out = renderPlayer(loadXm(buildXm({ rows: rows as never, patternRows: 8 }), { sampleRate: RATE }), {
		maxSeconds: 5,
	});
	assert.ok(out.ended && Math.abs(out.duration - 0.12) < 0.03, `duration ${out.duration}`);
	const g = renderPlayer(
		loadXm(buildXm({ rows: [[{ note: 49, instrument: 1, effect: 0x10, param: 32 }]] as never }), {
			sampleRate: RATE,
		}),
		{ maxSeconds: 1 },
	);
	const n = renderPlayer(loadXm(buildXm({ rows: [[{ note: 49, instrument: 1 }]] as never }), { sampleRate: RATE }), {
		maxSeconds: 1,
	});
	assert.ok(Math.abs(peak(g.left) / peak(n.left) - 0.5) < 0.02);
});

test('IT header, sample, pattern; note numbering: C-5 plays at the sample C5 speed', () => {
	const bytes = buildIt({ rows: [[{ note: 60, instrument: 1 }]], c5speed: 16726 });
	assert.ok(isIt(bytes));
	const song = parseIt(bytes);
	assert.equal(song.format, 'it');
	assert.equal(song.patterns[0].cells[0][0].note, 61);
	const out = renderPlayer(loadIt(bytes, { sampleRate: RATE }), { maxSeconds: 1 });
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 16726 / 32) < 1, `${frequency(out.left, RATE)}`);
	const up = renderPlayer(
		loadIt(buildIt({ rows: [[{ note: 72, instrument: 1 }]], c5speed: 16726 }), { sampleRate: RATE }),
		{ maxSeconds: 1 },
	);
	assert.ok(Math.abs(frequency(up.left, RATE, RATE / 4) / (16726 / 32) - 2) < 0.02);
});

test('IT effects: A sets the speed, volume column sets the volume, S-commands map to E-commands', () => {
	const rows = [[{ note: 60, instrument: 1, command: 1, param: 3 }], [{ command: 3, param: 0 }]];
	const out = renderPlayer(loadIt(buildIt({ rows, patternRows: 8 }), { sampleRate: RATE }), { maxSeconds: 5 });
	assert.ok(out.ended && Math.abs(out.duration - 0.12) < 0.03, `duration ${out.duration}`);
	const loud = renderPlayer(loadIt(buildIt({ rows: [[{ note: 60, instrument: 1 }]] }), { sampleRate: RATE }), {
		maxSeconds: 1,
	});
	const soft = renderPlayer(
		loadIt(buildIt({ rows: [[{ note: 60, instrument: 1, volume: 32 }]] }), { sampleRate: RATE }),
		{ maxSeconds: 1 },
	);
	assert.ok(Math.abs(peak(soft.left) / peak(loud.left) - 0.5) < 0.03, `${peak(soft.left) / peak(loud.left)}`);
	const cut = renderPlayer(
		loadIt(buildIt({ rows: [[{ note: 60, instrument: 1, command: 19, param: 0xc2 }]] }), { sampleRate: RATE }),
		{ maxSeconds: 1 },
	);
	assert.ok(peak(cut.left.subarray(0, 800)) > 0.01 && peak(cut.left.subarray(5000, 9000)) < 1e-4);
});

test('S3M: header, sample at its C-4 speed, the A (speed) effect and the C-4 note numbering', async () => {
	const { buildS3m } = await import('./xmitfile.ts');
	const { isS3m, parseS3m, loadS3m } = await import('../src/formats/tracker/s3m.ts');
	const bytes = buildS3m({ rows: [{ note: 0x40, instrument: 1 }], c2spd: 16726 });
	assert.ok(isS3m(bytes));
	const song = parseS3m(bytes);
	assert.equal(song.format, 's3m');
	assert.equal(song.instruments[0].samples[0].baseFreq, 16726);
	const out = renderPlayer(loadS3m(bytes, { sampleRate: RATE }), { maxSeconds: 1 });
	// C-4 (octave 4, note 0) plays the 32 sample cycle at c2spd: 16726 / 32 Hz
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 16726 / 32) < 1.5, `${frequency(out.left, RATE)}`);
	const up = renderPlayer(
		loadS3m(buildS3m({ rows: [{ note: 0x50, instrument: 1 }], c2spd: 16726 }), { sampleRate: RATE }),
		{ maxSeconds: 1 },
	);
	assert.ok(
		Math.abs(frequency(up.left, RATE, RATE / 4) / (16726 / 32) - 2) < 0.02,
		'one octave up doubles the pitch',
	);
	const fast = renderPlayer(
		loadS3m(buildS3m({ rows: [{ note: 0x40, instrument: 1, cmd: 1, info: 3 }] }), { sampleRate: RATE }),
		{ maxSeconds: 20 },
	);
	assert.ok(fast.ended && Math.abs(fast.duration - 3.84) < 0.1, `speed 3: ${fast.duration}`);
});

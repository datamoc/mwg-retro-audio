import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMod, loadMod, parseMod } from '../src/formats/tracker/mod.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { frequency, peak, rms, RATE } from './util.ts';
import { buildMod, type ModNote } from './modfile.ts';

// a 64 byte square cycle looped over its whole length
const SQUARE = Int8Array.from({ length: 64 }, (_, i) => (i < 32 ? 100 : -100));
const note = (period: number, extra: Partial<ModNote> = {}): ModNote => ({ period, sample: 1, ...extra });

function single(rows: ModNote[][], extra: Record<string, unknown> = {}): Uint8Array {
	return buildMod({ patterns: [rows], sample: SQUARE, loop: [0, 64], ...extra });
}

test('MOD header is recognised and parsed', () => {
	const bytes = single([[note(428)]]);
	assert.ok(isMod(bytes));
	const song = parseMod(bytes);
	assert.equal(song.channels, 4);
	assert.equal(song.patterns.length, 1);
	assert.equal(song.instruments[0].samples[0].data.length, 64);
	assert.equal(song.instruments[0].samples[0].loopType, 1);
	assert.ok(!isMod(new Uint8Array(2000)));
});

test('a note plays at the Paula pitch: 7093789.2 / (2 * period) samples per second', () => {
	const out = renderPlayer(loadMod(single([[note(428)]]), { sampleRate: RATE }), { maxSeconds: 1 });
	const expected = 7_093_789.2 / (2 * 428) / 64; // 129.5 Hz for the 64 sample looped square
	assert.ok(
		Math.abs(frequency(out.left, RATE, RATE / 4) - expected) < 0.5,
		`${frequency(out.left, RATE)} vs ${expected}`,
	);
});

test('NTSC Amiga clock raises the pitch by 0.9 percent', () => {
	const bytes = single([[note(428)]]);
	const f = (standard: 'pal' | 'ntsc'): number =>
		frequency(renderPlayer(loadMod(bytes, { sampleRate: RATE, standard }), { maxSeconds: 1 }).left, RATE, RATE / 4);
	assert.ok(Math.abs(f('ntsc') / f('pal') - 7_159_090.5 / 7_093_789.2) < 0.002);
});

test('speed 6 / tempo 125 plays a row every 120 ms: a 64 row pattern lasts 7.68 s and then the song ends', () => {
	const out = renderPlayer(loadMod(single([[note(428)]]), { sampleRate: RATE }), { maxSeconds: 20 });
	assert.ok(out.ended, 'finished');
	assert.ok(Math.abs(out.duration - 7.68) < 0.05, `duration ${out.duration}`);
});

test('effect F changes speed and tempo; D breaks the pattern', () => {
	const fast = single([[note(428, { effect: 0xf, param: 3 })]]);
	assert.ok(Math.abs(renderPlayer(loadMod(fast, { sampleRate: RATE }), { maxSeconds: 20 }).duration - 3.84) < 0.05);
	const tempo = single([[note(428, { effect: 0xf, param: 250 })]]); // 250 BPM: twice as fast
	assert.ok(Math.abs(renderPlayer(loadMod(tempo, { sampleRate: RATE }), { maxSeconds: 20 }).duration - 3.84) < 0.05);
	const rows: ModNote[][] = Array.from({ length: 64 }, () => [{}]);
	rows[3] = [{ effect: 0xd, param: 0 }]; // break after 4 rows: the song ends there
	assert.ok(
		Math.abs(renderPlayer(loadMod(single(rows), { sampleRate: RATE }), { maxSeconds: 20 }).duration - 0.48) < 0.05,
	);
});

test('volume (C), volume slide (A), arpeggio (0) and portamento (1) change the sound', () => {
	const quiet = renderPlayer(loadMod(single([[note(428, { effect: 0xc, param: 16 })]]), { sampleRate: RATE }), {
		maxSeconds: 1,
	});
	const loud = renderPlayer(loadMod(single([[note(428)]]), { sampleRate: RATE }), { maxSeconds: 1 });
	assert.ok(Math.abs(peak(quiet.left) / peak(loud.left) - 0.25) < 0.02);
	const rows: ModNote[][] = Array.from({ length: 64 }, () => [{}]);
	rows[0] = [note(428, { effect: 0xa, param: 0x04 })];
	for (let r = 1; r < 8; r++) rows[r] = [{ effect: 0xa, param: 0x04 }];
	const slid = renderPlayer(loadMod(single(rows), { sampleRate: RATE }), { maxSeconds: 1 });
	assert.ok(rms(slid.left, 0, 4000) > rms(slid.left, 30000, 34000) * 1.5);
	const p: ModNote[][] = Array.from({ length: 64 }, () => [{ effect: 1, param: 4 }]);
	p[0] = [note(428, { effect: 1, param: 4 })];
	const up = renderPlayer(loadMod(single(p), { sampleRate: RATE }), { maxSeconds: 2 });
	assert.ok(frequency(up.left.subarray(RATE), RATE) > frequency(up.left.subarray(0, 4000), RATE) * 1.3);
	const arp = renderPlayer(loadMod(single([[note(428, { effect: 0, param: 0x47 })]]), { sampleRate: RATE }), {
		maxSeconds: 1,
	});
	assert.notDeepEqual(arp.left, loud.left);
});

test('sample offset (9) skips the start; note cut (EC) silences after the given tick', () => {
	const data = Int8Array.from({ length: 512 }, (_, i) => (i < 256 ? 0 : 100));
	const bytes = buildMod({ patterns: [[[{ period: 428, sample: 1, effect: 9, param: 1 }]]], sample: data });
	const out = renderPlayer(loadMod(bytes, { sampleRate: RATE }), { maxSeconds: 1 });
	assert.ok(peak(out.left.subarray(0, 100)) > 0.01, 'starts in the loud half at once');
	const cut = renderPlayer(loadMod(single([[note(428, { effect: 0xe, param: 0xc2 })]]), { sampleRate: RATE }), {
		maxSeconds: 1,
	});
	assert.ok(
		peak(cut.left.subarray(0, 800)) > 0.01 && peak(cut.left.subarray(4000, 8000)) < 1e-4,
		'cut after 2 ticks',
	);
});

test('hard panning of the Amiga channels: channel 0 goes left; separation 0 makes it mono', () => {
	const bytes = single([[note(428), {}]]);
	const out = renderPlayer(loadMod(bytes, { sampleRate: RATE, separation: 1 }), { maxSeconds: 0.5 });
	assert.ok(peak(out.left) > 0.05 && peak(out.right) < 1e-5);
	const mono = renderPlayer(loadMod(bytes, { sampleRate: RATE, separation: 0 }), { maxSeconds: 0.5 });
	assert.ok(Math.abs(peak(mono.left) - peak(mono.right)) < 1e-4);
});

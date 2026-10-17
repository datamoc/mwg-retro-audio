import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseSci0, parseSciPatch } from '../src/formats/sci.ts';
import { MwaPlayer } from '../src/formats/mwa.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { frequency, peak, RATE } from './util.ts';

/** a patch.003 with one audible instrument (index 0): a sine carrier, silent modulator, sustained */
function patch(): Uint8Array {
	const p = new Uint8Array(1344);
	const ins = [0, 1, 0, 15, 0, 1, 0, 15, 63, 0, 0, 0, 1, 0, 1, 0, 15, 0, 1, 0, 15, 0, 0, 0, 0, 0, 0, 0];
	for (let i = 0; i < 48; i++) p.set(ins, i * 28);
	return p;
}

test('patch.003 is read in the 28 byte instrument layout, with or without the extractor resource header', () => {
	const bank = parseSciPatch(patch());
	assert.equal(bank.length, 96);
	assert.equal(bank[0].op[1].frequencyMult, 1);
	assert.equal(bank[0].op[0].totalLevel, 63);
	assert.equal(bank[0].algorithm, 0, 'the algorithm flag is stored inverted');
	const withHeader = new Uint8Array(1346);
	withHeader.set([0x89, 0x00]);
	withHeader.set(patch(), 2);
	assert.equal(parseSciPatch(withHeader).length, 96);
	assert.throws(() => parseSciPatch(new Uint8Array(100)), /unsupported/);
});

test('a hand made late SCI0 sound: voice allocation from the header, program, note on / off, pitch from the driver table', () => {
	const header = new Uint8Array(0x21);
	header[1] = 1; // channel 0: one voice
	header[2] = 0x04; // played by the AdLib
	// delta 0: program 0 on channel 0; delta 0: note on A4 (69), velocity 100; delta 60 ticks: note off; end
	const events = [0, 0xc0, 0, 0, 0x90, 69, 100, 60, 0x80, 69, 0, 0xfc];
	const data = parseSci0(Uint8Array.from([...header, ...events]), { patch: patch(), version: 'late' });
	assert.equal(data.chips[0].id, 'opl2');
	const out = renderPlayer(new MwaPlayer(data, { sampleRate: RATE }), { maxSeconds: 5 });
	// the driver's table: note 69 -> index 276 -> frequency 0x263, octave 5 - 1 = 4 ... f = fnum * 49716 / 2^(20 - block)
	const index = 69 << 2;
	const fnum = [
		0x157, 0x15c, 0x161, 0x166, 0x16b, 0x171, 0x176, 0x17b, 0x181, 0x186, 0x18c, 0x192, 0x198, 0x19e, 0x1a4, 0x1aa,
		0x1b0, 0x1b6, 0x1bd, 0x1c3, 0x1ca, 0x1d0, 0x1d7, 0x1de, 0x1e5, 0x1ec, 0x1f3, 0x1fa, 0x202, 0x209, 0x211, 0x218,
		0x220, 0x228, 0x230, 0x238, 0x241, 0x249, 0x252, 0x25a, 0x263, 0x26c, 0x275, 0x27e, 0x287, 0x290, 0x29a, 0x2a4,
	][index % 48];
	const block = Math.floor(index / 48) - 1;
	const expected = (fnum * 3_579_545) / 72 / 2 ** (20 - block);
	assert.ok(
		Math.abs(frequency(out.left.subarray(0, RATE * 0.9), RATE, 3000) - expected) < 1.5,
		`${frequency(out.left, RATE)} vs ${expected}`,
	);
	assert.ok(out.ended && Math.abs(out.duration - (60 / 60 + 0.5)) < 0.1, `duration ${out.duration}`);
	assert.ok(peak(out.left) > 0.05);
	// channel not flagged for the AdLib is silent
	header[2] = 0x01;
	const silent = parseSci0(Uint8Array.from([...header, ...events]), { patch: patch(), version: 'late' });
	assert.equal(silent.time.filter((_, i) => silent.addr[i] === 0xb0).length, 0);
});

// With the user's own game files: MW_SCI_DIR = folder holding sound.NNN and SysEx/patch.003 of King's Quest IV v1.006.
const dir = process.env.MW_SCI_DIR;
test(
	"real King's Quest IV sounds play through the AdLib driver (needs MW_SCI_DIR)",
	{ skip: !dir || !existsSync(`${dir}/SysEx/patch.003`) },
	() => {
		const bank = new Uint8Array(readFileSync(`${dir}/SysEx/patch.003`));
		for (const n of ['048', '002']) {
			const data = parseSci0(new Uint8Array(readFileSync(`${dir}/sound.${n}`)), { patch: bank, maxSeconds: 8 });
			assert.ok(data.time.length > 50, `sound.${n}: ${data.time.length} register writes`);
			const out = renderPlayer(new MwaPlayer(data, { sampleRate: RATE }), { maxSeconds: 10 });
			assert.ok(peak(out.left) > 0.1 && out.duration > 2);
		}
	},
);

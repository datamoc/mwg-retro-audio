import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDx7Bank, dx7Checksum, isDx7Bank, parseDx7Bank } from '../src/formats/dx7.ts';

test('DX7 32 voice bulk dump: header, checksum, packed voice fields', () => {
	const voice = new Array<number>(128).fill(0);
	// operator 6 (the first stored): rates 99 90 80 70, levels 99 80 60 0, output level 85, coarse 2 fine 7, detune 9
	voice.splice(0, 8, 99, 90, 80, 70, 99, 80, 60, 0);
	voice[14] = 85;
	voice[15] = (2 << 1) | 1;
	voice[16] = 7;
	voice[12] = (9 << 3) | 3;
	voice[110] = 21;
	voice[111] = 8 | 5;
	voice[116] = (3 << 4) | (2 << 1) | 1;
	voice.splice(118, 10, ...[...'E.PIANO 1 '].map((c) => c.charCodeAt(0)));
	const bytes = buildDx7Bank([voice]);
	assert.ok(isDx7Bank(bytes));
	const voices = parseDx7Bank(bytes);
	assert.equal(voices.length, 32);
	const v = voices[0];
	assert.equal(v.name, 'E.PIANO 1');
	assert.deepEqual(v.operators[0].rates, [99, 90, 80, 70]);
	assert.equal(v.operators[0].outputLevel, 85);
	assert.equal(v.operators[0].freqCoarse, 2);
	assert.equal(v.operators[0].oscMode, 1);
	assert.equal(v.operators[0].freqFine, 7);
	assert.equal(v.operators[0].detune, 9);
	assert.equal(v.operators[0].rateScale, 3);
	assert.equal(v.algorithm, 21);
	assert.equal(v.feedback, 5);
	assert.ok(v.oscKeySync);
	assert.equal(v.lfo.pitchModSens, 3);
	assert.equal(v.lfo.wave, 2);
	assert.ok(v.lfo.sync);
});

test('a corrupted dump or a foreign SysEx is refused', () => {
	const bytes = buildDx7Bank([new Array(128).fill(5)]);
	const bad = bytes.slice();
	bad[100] ^= 1;
	assert.throws(() => parseDx7Bank(bad), /checksum/);
	assert.ok(!isDx7Bank(new Uint8Array([0xf0, 0x41, 0x10, 0x16, 0x12, 0xf7])));
	assert.equal(dx7Checksum([1, 2, 3]), 0x7a);
});

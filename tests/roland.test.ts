import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildRolandDt1,
	MODEL_MT32,
	Mt32Memory,
	Mt32Session,
	mt32Area,
	parseRolandSysEx,
	rolandChecksum,
} from '../src/formats/roland.ts';

test('Roland checksum: the sum of address, data and checksum is a multiple of 128', () => {
	// a documented GS reset: F0 41 10 42 12 40 00 7F 00 41 F7
	assert.equal(rolandChecksum([0x40, 0x00, 0x7f, 0x00]), 0x41);
	for (const data of [[1, 2, 3], [0x7f, 0x7f, 0x7f, 0x7f], [0]]) {
		const sum =
			[0x10, 0x00, 0x16, ...data].reduce((a, b) => a + b, 0) + rolandChecksum([0x10, 0x00, 0x16, ...data]);
		assert.equal(sum % 128, 0);
	}
});

test('parse and build round-trip; altered messages are refused', () => {
	const gsReset = Uint8Array.from([0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0x00, 0x7f, 0x00, 0x41, 0xf7]);
	const m = parseRolandSysEx(gsReset)!;
	assert.equal(m.model, 0x42);
	assert.equal(m.address, 0x40007f);
	assert.deepEqual([...m.data], [0]);
	const built = buildRolandDt1(
		MODEL_MT32,
		0x10,
		Mt32Memory.display,
		[...'Hello MT-32'].map((c) => c.charCodeAt(0)),
	);
	assert.deepEqual(parseRolandSysEx(built)?.address, Mt32Memory.display);
	const bad = built.slice();
	bad[8] ^= 1;
	assert.equal(parseRolandSysEx(bad), null);
	assert.equal(parseRolandSysEx(Uint8Array.from([0xf0, 0x7e, 0x7f, 9, 1, 0xf7])), null);
});

test('MT-32 session keeps timbres, the LCD message, counts rejected messages and resets', () => {
	const s = new Mt32Session();
	assert.ok(s.approximate);
	assert.ok(
		s.receive(
			buildRolandDt1(
				MODEL_MT32,
				0x10,
				Mt32Memory.display,
				[...'LOADING'].map((c) => c.charCodeAt(0)),
			),
		),
	);
	assert.equal(s.lcd, 'LOADING');
	assert.ok(s.receive(buildRolandDt1(MODEL_MT32, 0x10, Mt32Memory.timbreMemory, [1, 2, 3, 4])));
	assert.equal(mt32Area(Mt32Memory.timbreMemory + 5), 'timbreMemory');
	assert.deepEqual([...s.memory.get(Mt32Memory.timbreMemory)!], [1, 2, 3, 4]);
	const corrupt = buildRolandDt1(MODEL_MT32, 0x10, Mt32Memory.system, [1]);
	corrupt[corrupt.length - 2] ^= 0x55;
	assert.ok(!s.receive(corrupt));
	assert.equal(s.rejected, 1);
	assert.ok(s.receive(buildRolandDt1(MODEL_MT32, 0x10, Mt32Memory.reset, [1])));
	assert.equal(s.memory.size, 0);
	assert.equal(s.resets, 1);
	// attaching a synthesiser replays what the game sent
	const got: number[] = [];
	s.receive(buildRolandDt1(MODEL_MT32, 0x10, Mt32Memory.system, [0x0a]));
	s.attach({ sysex: (m) => got.push(m.length), midi: () => {}, render: () => {} });
	assert.ok(!s.approximate && got.length === 4);
});

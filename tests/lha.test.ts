import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLha, parseLhaHeader, unlha } from '../src/formats/lha.ts';

// Archives produced by real tools (LHarc 3.13a for the Atari ST, LHA 2.55e for MS-DOS), taken from the public
// test suite of the Lhasa project (ISC licence). The stored (-lh0-) archive gives the expected content.
const load = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(new URL(`./fixtures/lha/${name}`, import.meta.url)));

function crc16(data: Uint8Array): number {
	let crc = 0;
	for (const b of data) {
		crc ^= b;
		for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
	}
	return crc;
}

test('headers are recognised for levels 0, 1 and 2', () => {
	const l0 = parseLhaHeader(load('atari_lh5.lzh'));
	assert.equal(l0?.method, '-lh5-');
	assert.equal(l0?.name, 'GPL2');
	const l1 = parseLhaHeader(load('atari_h1_lh5.lzh'));
	assert.equal(l1?.method, '-lh5-');
	const l2 = parseLhaHeader(load('atari_h2_lh5.lzh'));
	assert.equal(l2?.method, '-lh5-');
	assert.equal(l0?.originalSize, l1?.originalSize);
	assert.equal(l0?.originalSize, l2?.originalSize);
	assert.ok(isLha(load('atari_lh0.lzh')));
	assert.ok(!isLha(new Uint8Array(64)));
});

function headerCrc(archive: Uint8Array): number {
	const at = 22 + archive[21];
	return archive[at] | (archive[at + 1] << 8);
}

test('stored (-lh0-) archives are extracted verbatim and match the CRC of their header', () => {
	for (const name of ['atari_lh0.lzh', 'dos_lh0.lzh']) {
		const archive = load(name);
		const out = unlha(archive);
		assert.equal(out.length, parseLhaHeader(archive)!.originalSize, name);
		assert.equal(crc16(out), headerCrc(archive), name);
	}
});

test('-lh5- decompression matches the CRC stored by the packing tool (level 0 header)', () => {
	for (const name of ['atari_lh5.lzh', 'dos_lh5.lzh', 'atari_shorter.lzh']) {
		const archive = load(name);
		const out = unlha(archive);
		assert.equal(out.length, parseLhaHeader(archive)!.originalSize, name);
		assert.equal(crc16(out), headerCrc(archive), name);
	}
	assert.ok(new TextDecoder().decode(unlha(load('atari_lh5.lzh'))).includes('GNU GENERAL PUBLIC LICENSE'));
});

test('the same file packed with level 0, 1 and 2 headers and by two different tools decodes identically', () => {
	const expected = unlha(load('atari_lh5.lzh'));
	for (const name of ['atari_h1_lh5.lzh', 'atari_h2_lh5.lzh', 'dos_lh5.lzh']) {
		const out = unlha(load(name));
		assert.equal(out.length, expected.length, name);
		assert.deepEqual(Buffer.from(out), Buffer.from(expected), name);
	}
});

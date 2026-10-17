import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync, deflateSync } from 'node:zlib';
import { deflateRaw, deflateStored, gunzip, inflateRaw, isGzip, unzlib } from '../src/formats/inflate.ts';

// zlib from Node is the reference compressor; the decoder under test is our own
const sample = (): Uint8Array => {
	const out = new Uint8Array(200_000);
	let x = 12345;
	for (let i = 0; i < out.length; i++) {
		x = (x * 1103515245 + 12345) & 0x7fffffff;
		out[i] = i % 7 === 0 ? (x >> 16) & 255 : (i >> 3) & 63; // mixture of noise and repetition
	}
	return out;
};

test('inflateRaw decodes dynamic, fixed and stored blocks produced by zlib', () => {
	const data = sample();
	for (const level of [0, 1, 6, 9]) {
		assert.deepEqual(inflateRaw(new Uint8Array(deflateRawSync(data, { level }))), data, `level ${level}`);
	}
	const tiny = new TextEncoder().encode('abcabcabcabc');
	assert.deepEqual(inflateRaw(new Uint8Array(deflateRawSync(tiny, { strategy: 4 }))), tiny); // Z_FIXED
	assert.deepEqual(inflateRaw(new Uint8Array(deflateRawSync(new Uint8Array(0)))), new Uint8Array(0));
});

test('gzip and zlib wrappers', () => {
	const data = sample();
	const gz = new Uint8Array(gzipSync(data));
	assert.ok(isGzip(gz));
	assert.deepEqual(gunzip(gz), data);
	assert.deepEqual(unzlib(new Uint8Array(deflateSync(data))), data);
	assert.throws(() => gunzip(new Uint8Array(64)));
});

test('stored fallback and the native compressor round-trip through inflateRaw', async () => {
	const data = sample();
	assert.deepEqual(inflateRaw(deflateStored(data)), data);
	assert.deepEqual(inflateRaw(deflateStored(new Uint8Array(0))), new Uint8Array(0));
	const packed = await deflateRaw(data);
	assert.deepEqual(inflateRaw(packed), data);
	assert.ok(packed.length < data.length, 'the native compressor shrinks repetitive data');
});

test('corrupt data raises an error instead of looping', () => {
	assert.throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff])));
});

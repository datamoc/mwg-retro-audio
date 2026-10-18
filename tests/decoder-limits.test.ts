import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { DEFAULT_MAX_OUTPUT, gunzip, inflateRaw, unzlib } from '../src/formats/inflate.ts';
import { unlha } from '../src/formats/lha.ts';

/** a stored LHA level 0 header for `name`, claiming `originalSize` bytes and carrying `payload` */
function lhaClaiming(originalSize: number, payload: Uint8Array): Uint8Array {
	const name = 'a.ym';
	const header = new Uint8Array(22 + name.length + 2);
	header[0] = header.length - 2;
	header.set(
		[...'-lh5-'].map((c) => c.charCodeAt(0)),
		2,
	);
	const view = new DataView(header.buffer);
	view.setUint32(7, payload.length, true);
	view.setUint32(11, originalSize, true);
	header[20] = 0;
	header[21] = name.length;
	header.set(
		[...name].map((c) => c.charCodeAt(0)),
		22,
	);
	return Uint8Array.from([...header, ...payload]);
}

test('a DEFLATE bomb is refused once it passes the limit, without allocating what it claims', () => {
	const zeros = new Uint8Array(8 * 1024 * 1024);
	const bomb = deflateRawSync(zeros);
	assert.ok(bomb.length < 20_000, `${bomb.length} bytes that expand to 8 MiB`);
	assert.equal(inflateRaw(bomb).length, zeros.length, 'under the default limit it inflates as before');
	assert.throws(() => inflateRaw(bomb, 0, 0, 1024 * 1024), /over the limit of 1048576 bytes/);
	assert.equal(DEFAULT_MAX_OUTPUT, 64 * 1024 * 1024);
});

test('a gzip member that claims four gigabytes does not allocate them', () => {
	const gz = Uint8Array.from(gzipSync(Buffer.from('hello hello hello')));
	new DataView(gz.buffer).setUint32(gz.length - 4, 0xffffffff, true); //the declared size, which nothing checks
	assert.deepEqual(gunzip(gz), new TextEncoder().encode('hello hello hello'));
	assert.throws(() => gunzip(Uint8Array.from(gzipSync(Buffer.alloc(2_000_000))), 1000), /over the limit/);
});

test('unzlib takes the same limit', () => {
	const packed = Uint8Array.from([0x78, 0x01, ...deflateRawSync(Buffer.alloc(100_000)), 0, 0, 0, 0]);
	assert.equal(unzlib(packed).length, 100_000);
	assert.throws(() => unzlib(packed, 1000), /over the limit/);
});

test('an LHA header that claims more than the limit is refused before anything is allocated', () => {
	const hostile = lhaClaiming(0xfffffff0, new Uint8Array(8));
	assert.throws(() => unlha(hostile), /claims 4294967280 bytes, over the limit/);
	assert.throws(() => unlha(lhaClaiming(5000, new Uint8Array(8)), 1000), /over the limit of 1000/);
});

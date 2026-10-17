/**
 * Dependency-free DEFLATE (RFC 1951) decoder with gzip (RFC 1952) and zlib (RFC 1950) wrappers, used for `.vgz` files
 * and for the compressed payload of the MWA container. Decoding is synchronous so that a file can be loaded without
 * any asynchronous stream API. Compression uses the platform's `CompressionStream` when it exists and falls back to
 * stored blocks (valid DEFLATE, no size gain) otherwise.
 */

const LENGTH_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
	8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** canonical Huffman decoding table: counts per length and symbols sorted by code */
interface Table {
	count: Uint16Array;
	symbol: Uint16Array;
}

function buildTable(lengths: ArrayLike<number>, n: number): Table {
	const count = new Uint16Array(16);
	const symbol = new Uint16Array(n);
	for (let i = 0; i < n; i++) count[lengths[i]]++;
	count[0] = 0;
	const offs = new Uint16Array(16);
	for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
	for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
	return { count, symbol };
}

let fixedLit: Table | null = null;
let fixedDist: Table | null = null;

class Inflater {
	private pos: number;
	private bitBuf = 0;
	private bitCount = 0;
	private out: Uint8Array;
	private outPos = 0;

	constructor(
		private readonly data: Uint8Array,
		start: number,
		expectedSize: number,
	) {
		this.pos = start;
		this.out = new Uint8Array(Math.max(1024, expectedSize || data.length * 4));
	}

	private bits(n: number): number {
		while (this.bitCount < n) {
			if (this.pos >= this.data.length) throw new Error('inflate: unexpected end of data');
			this.bitBuf |= this.data[this.pos++] << this.bitCount;
			this.bitCount += 8;
		}
		const v = this.bitBuf & ((1 << n) - 1);
		this.bitBuf >>>= n;
		this.bitCount -= n;
		return v;
	}

	private decode(t: Table): number {
		let code = 0;
		let first = 0;
		let index = 0;
		for (let len = 1; len < 16; len++) {
			code |= this.bits(1);
			const count = t.count[len];
			if (code - count < first) return t.symbol[index + (code - first)];
			index += count;
			first += count;
			first <<= 1;
			code <<= 1;
		}
		throw new Error('inflate: invalid Huffman code');
	}

	private ensure(extra: number): void {
		if (this.outPos + extra <= this.out.length) return;
		const bigger = new Uint8Array(Math.max(this.out.length * 2, this.outPos + extra));
		bigger.set(this.out.subarray(0, this.outPos));
		this.out = bigger;
	}

	private codes(lit: Table, dist: Table): void {
		for (;;) {
			const sym = this.decode(lit);
			if (sym < 256) {
				this.ensure(1);
				this.out[this.outPos++] = sym;
			} else if (sym === 256) {
				return;
			} else {
				const li = sym - 257;
				if (li >= 29) throw new Error('inflate: invalid length symbol');
				const len = LENGTH_BASE[li] + this.bits(LENGTH_EXTRA[li]);
				const di = this.decode(dist);
				if (di >= 30) throw new Error('inflate: invalid distance symbol');
				const d = DIST_BASE[di] + this.bits(DIST_EXTRA[di]);
				if (d > this.outPos) throw new Error('inflate: distance too far back');
				this.ensure(len);
				for (let k = 0; k < len; k++) {
					this.out[this.outPos] = this.out[this.outPos - d];
					this.outPos++;
				}
			}
		}
	}

	run(): { data: Uint8Array; end: number } {
		let last = 0;
		while (!last) {
			last = this.bits(1);
			const type = this.bits(2);
			if (type === 0) {
				this.bitBuf = 0;
				this.bitCount = 0;
				if (this.pos + 4 > this.data.length) throw new Error('inflate: truncated stored block');
				const len = this.data[this.pos] | (this.data[this.pos + 1] << 8);
				const nlen = this.data[this.pos + 2] | (this.data[this.pos + 3] << 8);
				if (len !== (~nlen & 0xffff)) throw new Error('inflate: bad stored block length');
				this.pos += 4;
				if (this.pos + len > this.data.length) throw new Error('inflate: truncated stored block');
				this.ensure(len);
				this.out.set(this.data.subarray(this.pos, this.pos + len), this.outPos);
				this.outPos += len;
				this.pos += len;
			} else if (type === 1) {
				if (!fixedLit || !fixedDist) {
					const l = new Uint8Array(288);
					l.fill(8, 0, 144);
					l.fill(9, 144, 256);
					l.fill(7, 256, 280);
					l.fill(8, 280, 288);
					fixedLit = buildTable(l, 288);
					fixedDist = buildTable(new Uint8Array(30).fill(5), 30);
				}
				this.codes(fixedLit, fixedDist);
			} else if (type === 2) {
				const nlen = this.bits(5) + 257;
				const ndist = this.bits(5) + 1;
				const ncode = this.bits(4) + 4;
				const lengths = new Uint8Array(320);
				for (let i = 0; i < ncode; i++) lengths[CLEN_ORDER[i]] = this.bits(3);
				const clen = buildTable(lengths.subarray(0, 19), 19);
				const all = new Uint8Array(nlen + ndist);
				let i = 0;
				while (i < nlen + ndist) {
					const sym = this.decode(clen);
					if (sym < 16) all[i++] = sym;
					else {
						let prev = 0;
						let rep: number;
						if (sym === 16) {
							if (i === 0) throw new Error('inflate: repeat without previous length');
							prev = all[i - 1];
							rep = 3 + this.bits(2);
						} else if (sym === 17) rep = 3 + this.bits(3);
						else rep = 11 + this.bits(7);
						if (i + rep > nlen + ndist) throw new Error('inflate: too many code lengths');
						while (rep--) all[i++] = prev;
					}
				}
				this.codes(buildTable(all.subarray(0, nlen), nlen), buildTable(all.subarray(nlen), ndist));
			} else throw new Error('inflate: invalid block type');
		}
		return { data: this.out.slice(0, this.outPos), end: this.pos };
	}
}

/** Decode a raw DEFLATE stream starting at `start`; `expectedSize` is only a hint to size the buffer */
export function inflateRaw(data: Uint8Array, start = 0, expectedSize = 0): Uint8Array {
	return new Inflater(data, start, expectedSize).run().data;
}

/** true when the bytes start like a gzip member */
export function isGzip(data: Uint8Array): boolean {
	return data.length > 18 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 8;
}

/** Decode a gzip file (the first member): used by `.vgz` */
export function gunzip(data: Uint8Array): Uint8Array {
	if (!isGzip(data)) throw new Error('gunzip: not a gzip stream');
	const flags = data[3];
	let p = 10;
	if (flags & 4) p += 2 + (data[p] | (data[p + 1] << 8));
	if (flags & 8) while (data[p++] !== 0);
	if (flags & 16) while (data[p++] !== 0);
	if (flags & 2) p += 2;
	const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(data.length - 4, true);
	return inflateRaw(data, p, size);
}

/** Decode a zlib stream (2 byte header) */
export function unzlib(data: Uint8Array): Uint8Array {
	if (data.length < 6 || (data[0] & 15) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) {
		throw new Error('unzlib: not a zlib stream');
	}
	return inflateRaw(data, 2);
}

/** DEFLATE using only stored blocks: always valid, never smaller */
export function deflateStored(data: Uint8Array): Uint8Array {
	const blocks = Math.max(1, Math.ceil(data.length / 65535));
	const out = new Uint8Array(data.length + blocks * 5);
	let o = 0;
	for (let b = 0; b < blocks; b++) {
		const chunk = data.subarray(b * 65535, Math.min(data.length, (b + 1) * 65535));
		out[o++] = b === blocks - 1 ? 1 : 0;
		out[o++] = chunk.length & 255;
		out[o++] = chunk.length >> 8;
		out[o++] = ~chunk.length & 255;
		out[o++] = (~chunk.length >> 8) & 255;
		out.set(chunk, o);
		o += chunk.length;
	}
	return out;
}

/**
 * Compress with the platform's native `CompressionStream('deflate-raw')` when available (browsers, Node >= 18);
 * falls back to stored blocks so the result is always a valid stream readable by `inflateRaw`.
 */
export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const Compression = (globalThis as { CompressionStream?: new (format: string) => unknown }).CompressionStream;
	if (!Compression) return deflateStored(data);
	try {
		const stream = new Blob([data as Uint8Array<ArrayBuffer>])
			.stream()
			.pipeThrough(new Compression('deflate-raw') as never);
		return new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer());
	} catch {
		return deflateStored(data);
	}
}

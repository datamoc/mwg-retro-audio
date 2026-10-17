/**
 * LHA / LZH decompressor for the methods used by retro music files: `-lh0-` (stored), `-lh5-`, `-lh6-` and `-lh7-`
 * (Huffman + sliding window, 8 / 32 / 64 KiB). Header levels 0, 1 and 2 are understood. Atari ST `.ym` files are
 * almost always a single file packed with `-lh5-`.
 */

const THRESHOLD = 3;
const MAXMATCH = 256;
const NC = 255 + MAXMATCH + 2 - THRESHOLD; // 510 literal / length symbols
const CBIT = 9;
const NT = 16 + 3; // code-length alphabet
const TBIT = 5;

interface Method {
	/** window size is 2^dicBit */
	dicBit: number;
	/** number of distance symbols */
	np: number;
	pbit: number;
}

const METHODS: Record<string, Method> = {
	'-lh5-': { dicBit: 13, np: 14, pbit: 4 },
	'-lh6-': { dicBit: 15, np: 16, pbit: 5 },
	'-lh7-': { dicBit: 16, np: 17, pbit: 5 },
};

export interface LhaEntry {
	name: string;
	method: string;
	packedSize: number;
	originalSize: number;
	/** offset of the packed data inside the archive */
	dataOffset: number;
}

/** MSB-first bit reader over a byte array */
class BitReader {
	private pos: number;
	private bitBuf = 0; // up to 32 bits, left-aligned in the low 'count' bits
	private count = 0;

	constructor(
		private readonly data: Uint8Array,
		start: number,
		private readonly end: number,
	) {
		this.pos = start;
	}

	/** peek the next `n` bits (n <= 16), zero-padded after the end */
	peek(n: number): number {
		while (this.count < n) {
			const b = this.pos < this.end ? this.data[this.pos] : 0;
			this.pos++;
			this.bitBuf = ((this.bitBuf << 8) | b) >>> 0;
			this.count += 8;
		}
		return (this.bitBuf >>> (this.count - n)) & ((1 << n) - 1);
	}

	skip(n: number): void {
		this.count -= n;
		this.bitBuf &= this.count >= 32 ? 0xffffffff : (1 << this.count) - 1;
	}

	read(n: number): number {
		if (n === 0) return 0;
		const v = this.peek(n);
		this.skip(n);
		return v;
	}
}

/** Canonical Huffman table decoded bit by bit (codes are assigned by increasing length, then symbol index) */
class Huffman {
	private readonly first = new Int32Array(18);
	private readonly offset = new Int32Array(18);
	private readonly count = new Int32Array(18);
	private readonly symbols: Uint16Array;
	/** when the alphabet has a single symbol it is coded with zero bits */
	private single = -1;

	constructor(lengths: ArrayLike<number>, n: number, single = -1) {
		this.single = single;
		this.symbols = new Uint16Array(n);
		for (let i = 0; i < n; i++) this.count[lengths[i]]++;
		this.count[0] = 0;
		let code = 0;
		let off = 0;
		for (let len = 1; len <= 16; len++) {
			code = (code + this.count[len - 1]) << 1;
			this.first[len] = code;
			this.offset[len] = off;
			off += this.count[len];
		}
		const next = this.offset.slice();
		for (let i = 0; i < n; i++) if (lengths[i]) this.symbols[next[lengths[i]]++] = i;
	}

	decode(br: BitReader): number {
		if (this.single >= 0) return this.single;
		let code = 0;
		for (let len = 1; len <= 16; len++) {
			code = (code << 1) | br.read(1);
			const idx = code - this.first[len];
			if (idx >= 0 && idx < this.count[len]) return this.symbols[this.offset[len] + idx];
		}
		throw new Error('LHA: invalid Huffman code');
	}
}

/** Decode `-lh5-` / `-lh6-` / `-lh7-` data into exactly `originalSize` bytes */
function decodeLzh(data: Uint8Array, start: number, end: number, originalSize: number, m: Method): Uint8Array {
	const out = new Uint8Array(originalSize);
	const br = new BitReader(data, start, end);
	let outPos = 0;
	let blockSize = 0;
	let cTable: Huffman | null = null;
	let pTable: Huffman | null = null;

	/** read the code-length table of the length alphabet (nn symbols, nbit-bit count) */
	const readPtLen = (nn: number, nbit: number, special: number): Huffman => {
		const lens = new Uint8Array(nn);
		const n = br.read(nbit);
		if (n === 0) return new Huffman(lens, nn, br.read(nbit));
		let i = 0;
		while (i < n) {
			let c = br.peek(3);
			if (c === 7) {
				// unary extension: one more bit set adds one to the length
				let mask = 1 << 12;
				const bits = br.peek(16);
				while (bits & mask) {
					mask >>= 1;
					c++;
				}
			}
			br.skip(c < 7 ? 3 : c - 3);
			lens[i++] = c;
			if (i === special) {
				let z = br.read(2);
				while (z-- > 0) lens[i++] = 0;
			}
		}
		return new Huffman(lens, nn);
	};

	const readCLen = (pt: Huffman): Huffman => {
		const lens = new Uint8Array(NC);
		const n = br.read(CBIT);
		if (n === 0) return new Huffman(lens, NC, br.read(CBIT));
		let i = 0;
		while (i < n) {
			let c = pt.decode(br);
			if (c <= 2) {
				if (c === 0) c = 1;
				else if (c === 1) c = br.read(4) + 3;
				else c = br.read(CBIT) + 20;
				while (c-- > 0) lens[i++] = 0;
			} else lens[i++] = c - 2;
		}
		return new Huffman(lens, NC);
	};

	let blocks = 0;
	while (outPos < originalSize) {
		if (blockSize === 0) {
			blocks++;
			blockSize = br.read(16);
			const pt = readPtLen(NT, TBIT, 3);
			cTable = readCLen(pt);
			pTable = readPtLen(m.np, m.pbit, -1);
		}
		blockSize--;
		let c: number;
		try {
			c = cTable!.decode(br);
		} catch (e) {
			const err = new Error(`${(e as Error).message} (output ${outPos}, block ${blocks})`) as Error & {
				partial?: Uint8Array;
			};
			err.partial = out.slice(0, outPos);
			throw err;
		}
		if (c < 256) {
			out[outPos++] = c;
			continue;
		}
		const len = c - 256 + THRESHOLD;
		let p = pTable!.decode(br);
		if (p !== 0) p = (1 << (p - 1)) + br.read(p - 1);
		const dist = p + 1;
		for (let k = 0; k < len && outPos < originalSize; k++) {
			out[outPos] = outPos - dist >= 0 ? out[outPos - dist] : 0x20; // the window starts filled with spaces
			outPos++;
		}
	}
	return out;
}

/** Read the first entry of an LHA archive: header levels 0, 1 and 2 */
export function parseLhaHeader(buf: Uint8Array): LhaEntry | null {
	if (buf.length < 22) return null;
	const method = String.fromCharCode(buf[2], buf[3], buf[4], buf[5], buf[6]);
	if (!/^-lh[0-9a-d]-$/.test(method)) return null;
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const level = buf[20];
	let packedSize = view.getUint32(7, true);
	const originalSize = view.getUint32(11, true);
	if (level === 2) {
		const headerSize = view.getUint16(0, true);
		return { name: '', method, packedSize, originalSize, dataOffset: headerSize };
	}
	const baseSize = buf[0];
	const nameLen = buf[21];
	let name = '';
	for (let i = 0; i < nameLen; i++) name += String.fromCharCode(buf[22 + i]);
	let dataOffset = baseSize + 2;
	if (level === 1) {
		// extended headers follow the base header: each starts with its own size, a zero size ends the chain
		let p = dataOffset - 2; // the "next header size" field sits at the end of the base header
		let ext = 0;
		let next = view.getUint16(p, true);
		while (next !== 0 && p + next <= buf.length) {
			ext += next;
			p += next;
			next = view.getUint16(p, true);
		}
		dataOffset += ext;
		packedSize -= ext;
	}
	return { name, method, packedSize, originalSize, dataOffset };
}

export function isLha(buf: Uint8Array): boolean {
	return parseLhaHeader(buf) !== null;
}

/** Extract the first file of an LHA archive */
export function unlha(buf: Uint8Array): Uint8Array {
	const e = parseLhaHeader(buf);
	if (!e) throw new Error('not an LHA archive');
	if (e.method === '-lh0-' || e.method === '-lhd-') return buf.slice(e.dataOffset, e.dataOffset + e.originalSize);
	const m = METHODS[e.method];
	if (!m) throw new Error(`unsupported LHA method ${e.method}`);
	return decodeLzh(buf, e.dataOffset, Math.min(buf.length, e.dataOffset + e.packedSize), e.originalSize, m);
}

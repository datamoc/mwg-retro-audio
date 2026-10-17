/**
 * FLAC encoder in plain TypeScript: no dependency, works in a browser and in Node.
 *
 * Lossless, 16 or 24 bit, stereo. Each block picks the cheapest of the four stereo layouts (left/right, left/side,
 * side/right, mid/side) and, per channel, a constant, a verbatim or a fixed polynomial predictor of order 0-4 with a
 * partitioned Rice code. There is no LPC stage: on the smooth, tonal material of the chips and synthesisers the fixed
 * predictors are within a few percent of it, and the encoder stays small and fast. The STREAMINFO carries the MD5 of
 * the audio, so `flac -t` and the decoders can verify the file.
 */
import { vorbisComment } from './vorbisComment.ts';

export interface FlacOptions {
	/** 16 (default) or 24 */
	bitsPerSample?: 16 | 24;
	/** samples per block, 256..65535 (default 4096) */
	blockSize?: number;
	/** Vorbis comments (TITLE, ARTIST, COMMENT...) */
	tags?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------------- bit writer

class BitWriter {
	private bytes = new Uint8Array(1 << 16);
	length = 0;
	private acc = 0;
	private bits = 0;

	private ensure(extra: number): void {
		if (this.length + extra <= this.bytes.length) return;
		const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
		next.set(this.bytes.subarray(0, this.length));
		this.bytes = next;
	}

	/** write the low `n` bits of `value` (n up to 32, value treated as unsigned) */
	write(value: number, n: number): void {
		while (n > 0) {
			const take = Math.min(n, 8 - this.bits);
			const chunk = Math.floor(value / 2 ** (n - take)) % 2 ** take;
			this.acc = (this.acc << take) | chunk;
			this.bits += take;
			n -= take;
			if (this.bits === 8) {
				this.ensure(1);
				this.bytes[this.length++] = this.acc;
				this.acc = 0;
				this.bits = 0;
			}
		}
	}

	/** write a signed value in `n` bits, two's complement */
	writeSigned(value: number, n: number): void {
		this.write(value < 0 ? value + 2 ** n : value, n);
	}

	unary(zeros: number): void {
		for (let i = zeros; i > 0;) {
			const take = Math.min(i, 24);
			this.write(0, take);
			i -= take;
		}
		this.write(1, 1);
	}

	alignToByte(): void {
		if (this.bits > 0) this.write(0, 8 - this.bits);
	}

	take(): Uint8Array {
		return this.bytes.subarray(0, this.length);
	}
}

// ---------------------------------------------------------------------------------------------------- checksums

const CRC8 = (() => {
	const t = new Uint8Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
		t[i] = c;
	}
	return t;
})();

const CRC16 = (() => {
	const t = new Uint16Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i << 8;
		for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
		t[i] = c;
	}
	return t;
})();

const crc8 = (b: Uint8Array, from: number, to: number): number => {
	let c = 0;
	for (let i = from; i < to; i++) c = CRC8[c ^ b[i]];
	return c;
};

const crc16 = (b: Uint8Array, from: number, to: number): number => {
	let c = 0;
	for (let i = from; i < to; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
	return c;
};

/** MD5 of a byte array (the FLAC STREAMINFO field; not used for anything security related) */
export function md5(data: Uint8Array): Uint8Array {
	const K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
	const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
	const padded = (((data.length + 8) >> 6) + 1) << 6;
	const msg = new Uint8Array(padded);
	msg.set(data);
	msg[data.length] = 0x80;
	const view = new DataView(msg.buffer);
	view.setUint32(padded - 8, (data.length * 8) >>> 0, true);
	view.setUint32(padded - 4, Math.floor(data.length / 2 ** 29), true);
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const M = new Uint32Array(16);
	for (let off = 0; off < padded; off += 64) {
		for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
		let A = a0;
		let B = b0;
		let C = c0;
		let D = d0;
		for (let i = 0; i < 64; i++) {
			let F: number;
			let g: number;
			if (i < 16) {
				F = (B & C) | (~B & D);
				g = i;
			} else if (i < 32) {
				F = (D & B) | (~D & C);
				g = (5 * i + 1) & 15;
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) & 15;
			} else {
				F = C ^ (B | ~D);
				g = (7 * i) & 15;
			}
			F = (F + A + K[i] + M[g]) | 0;
			A = D;
			D = C;
			C = B;
			const s = S[(i >> 4) * 4 + (i & 3)];
			B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
		}
		a0 = (a0 + A) | 0;
		b0 = (b0 + B) | 0;
		c0 = (c0 + C) | 0;
		d0 = (d0 + D) | 0;
	}
	const out = new Uint8Array(16);
	const ov = new DataView(out.buffer);
	ov.setUint32(0, a0, true);
	ov.setUint32(4, b0, true);
	ov.setUint32(8, c0, true);
	ov.setUint32(12, d0, true);
	return out;
}

// ---------------------------------------------------------------------------------------------------- subframes

const MAX_RICE = 14;
const POW = Float64Array.from({ length: 32 }, (_, k) => 2 ** k);
const MAX_PARTITION_ORDER = 6;

interface Subframe {
	bits: number;
	write(w: BitWriter): void;
}

const zigzag = (r: number): number => (r >= 0 ? r * 2 : -r * 2 - 1);

function residuals(s: Int32Array, order: number, out: Float64Array): void {
	const n = s.length;
	for (let i = 0; i < order; i++) out[i] = 0;
	switch (order) {
		case 0:
			for (let i = 0; i < n; i++) out[i] = s[i];
			break;
		case 1:
			for (let i = 1; i < n; i++) out[i] = s[i] - s[i - 1];
			break;
		case 2:
			for (let i = 2; i < n; i++) out[i] = s[i] - 2 * s[i - 1] + s[i - 2];
			break;
		case 3:
			for (let i = 3; i < n; i++) out[i] = s[i] - 3 * s[i - 1] + 3 * s[i - 2] - s[i - 3];
			break;
		default:
			for (let i = 4; i < n; i++) out[i] = s[i] - 4 * s[i - 1] + 6 * s[i - 2] - 4 * s[i - 3] + s[i - 4];
	}
}

/** the cheapest partitioned Rice coding of `res[order..n)`: returns its size and a writer */
function riceCoding(res: Float64Array, n: number, order: number): { bits: number; write(w: BitWriter): void } {
	let maxP = 0;
	while (maxP < MAX_PARTITION_ORDER && n % 2 ** (maxP + 1) === 0 && n >> (maxP + 1) > order) maxP++;
	const parts = 2 ** maxP;
	const size = n >> maxP;
	// sums[p * 15 + k] = sum over partition p of (zigzag(r) >> k), counts[p] = residual samples in it
	const sums = new Float64Array(parts * (MAX_RICE + 1));
	const counts = new Int32Array(parts);
	for (let p = 0; p < parts; p++) {
		const from = p === 0 ? order : p * size;
		counts[p] = (p + 1) * size - from;
		for (let i = from; i < (p + 1) * size; i++) {
			const u = zigzag(res[i]);
			for (let k = 0; k <= MAX_RICE; k++) sums[p * (MAX_RICE + 1) + k] += Math.floor(u / POW[k]);
		}
	}
	let best = { cost: Infinity, order: 0, params: [] as number[] };
	let curSums = sums;
	let curCounts = counts;
	for (let po = maxP; po >= 0; po--) {
		const np = 2 ** po;
		let cost = 0;
		const params: number[] = [];
		for (let p = 0; p < np; p++) {
			let bk = 0;
			let bc = Infinity;
			for (let k = 0; k <= MAX_RICE; k++) {
				const c = curCounts[p] * (k + 1) + curSums[p * (MAX_RICE + 1) + k];
				if (c < bc) {
					bc = c;
					bk = k;
				}
			}
			params.push(bk);
			cost += bc + 4;
		}
		if (cost < best.cost) best = { cost, order: po, params };
		if (po > 0) {
			const half = np / 2;
			const ns = new Float64Array(half * (MAX_RICE + 1));
			const nc = new Int32Array(half);
			for (let p = 0; p < half; p++) {
				nc[p] = curCounts[2 * p] + curCounts[2 * p + 1];
				for (let k = 0; k <= MAX_RICE; k++)
					ns[p * (MAX_RICE + 1) + k] =
						curSums[2 * p * (MAX_RICE + 1) + k] + curSums[(2 * p + 1) * (MAX_RICE + 1) + k];
			}
			curSums = ns;
			curCounts = nc;
		}
	}
	const { order: po, params } = best;
	return {
		bits: 2 + 4 + best.cost,
		write(w: BitWriter): void {
			w.write(0, 2); // 4 bit Rice parameters
			w.write(po, 4);
			const np = 2 ** po;
			const sz = n >> po;
			for (let p = 0; p < np; p++) {
				const k = params[p];
				w.write(k, 4);
				for (let i = p === 0 ? order : p * sz; i < (p + 1) * sz; i++) {
					const u = zigzag(res[i]);
					w.unary(Math.floor(u / POW[k]));
					if (k > 0) w.write(u % POW[k], k);
				}
			}
		},
	};
}

interface Analysis {
	constant: boolean;
	order: number;
	/** a cheap estimate of the coded size in bits, used to choose the stereo layout */
	estimate: number;
}

/** the best fixed order of a channel (smallest sum of residual magnitudes) and a size estimate, with no coding yet */
function analyse(s: Int32Array, bps: number, scratch: Float64Array): Analysis {
	const n = s.length;
	let constant = true;
	for (let i = 1; i < n; i++)
		if (s[i] !== s[0]) {
			constant = false;
			break;
		}
	if (constant) return { constant, order: 0, estimate: 8 + bps };
	const maxOrder = Math.min(4, n - 1);
	let order = 0;
	let best = Infinity;
	for (let o = 0; o <= maxOrder; o++) {
		residuals(s, o, scratch);
		let sum = 0;
		for (let i = o; i < n; i++) sum += Math.abs(scratch[i]);
		if (sum < best) {
			best = sum;
			order = o;
		}
	}
	return { constant, order, estimate: order * bps + n * (Math.log2(1 + best / Math.max(1, n - order)) + 2) };
}

function encodeSubframe(s: Int32Array, bps: number, scratch: Float64Array, a: Analysis): Subframe {
	const n = s.length;
	if (a.constant)
		return {
			bits: 8 + bps,
			write(w) {
				w.write(0, 8); // zero pad, type CONSTANT, no wasted bits
				w.writeSigned(s[0], bps);
			},
		};
	residuals(s, a.order, scratch);
	const res = scratch.slice(0, n); // the writer runs after `scratch` has been reused
	const rice = riceCoding(res, n, a.order);
	const fixedBits = 8 + a.order * bps + rice.bits;
	const verbatimBits = 8 + n * bps;
	if (verbatimBits <= fixedBits)
		return {
			bits: verbatimBits,
			write(w) {
				w.write(0b00000010, 8); // zero pad, type VERBATIM (000001), no wasted bits
				for (let i = 0; i < n; i++) w.writeSigned(s[i], bps);
			},
		};
	return {
		bits: fixedBits,
		write(w) {
			w.write(0b00010000 | (a.order << 1), 8); // zero pad, type FIXED (001xxx), no wasted bits
			for (let i = 0; i < a.order; i++) w.writeSigned(s[i], bps);
			rice.write(w);
		},
	};
}

// ---------------------------------------------------------------------------------------------------- frames

const BLOCK_CODES: Record<number, number> = {
	192: 1,
	576: 2,
	1152: 3,
	2304: 4,
	4608: 5,
	256: 8,
	512: 9,
	1024: 10,
	2048: 11,
	4096: 12,
	8192: 13,
	16384: 14,
	32768: 15,
};

/** the frame number in the UTF-8 like variable length form of the FLAC frame header */
function frameNumber(w: BitWriter, n: number): void {
	if (n < 0x80) return w.write(n, 8);
	let extra = 1;
	while (n >= 2 ** (6 * extra + (6 - extra))) extra++;
	w.write(((0xff << (8 - extra - 1)) & 0xff) | Math.floor(n / 2 ** (6 * extra)), 8);
	for (let k = extra - 1; k >= 0; k--) w.write(0x80 | (Math.floor(n / 2 ** (6 * k)) & 0x3f), 8);
}

const toInt = (x: number, max: number): number => Math.max(-max - 1, Math.min(max, Math.round(x * max)));

/** Encode stereo float audio (-1..1) as a FLAC file */
export function encodeFlac(
	left: Float32Array,
	right: Float32Array,
	sampleRate: number,
	options: FlacOptions = {},
): Uint8Array {
	const bps = options.bitsPerSample ?? 16;
	if (bps !== 16 && bps !== 24) throw new RangeError('FLAC export supports 16 and 24 bits per sample');
	const blockSize = options.blockSize ?? 4096;
	if (!Number.isInteger(blockSize) || blockSize < 256 || blockSize > 65535)
		throw new RangeError('block size must be 256..65535');
	if (left.length !== right.length) throw new RangeError('left and right must have the same length');
	if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350)
		throw new RangeError('unsupported sample rate');
	const total = left.length;
	const max = 2 ** (bps - 1) - 1;
	const L = new Int32Array(total);
	const R = new Int32Array(total);
	for (let i = 0; i < total; i++) {
		L[i] = toInt(left[i], max);
		R[i] = toInt(right[i], max);
	}
	// MD5 of the interleaved little-endian signed samples
	const width = bps / 8;
	const pcm = new Uint8Array(total * 2 * width);
	for (let i = 0; i < total; i++)
		for (let c = 0; c < 2; c++) {
			const v = c === 0 ? L[i] : R[i];
			const o = (i * 2 + c) * width;
			for (let b = 0; b < width; b++) pcm[o + b] = (v >> (8 * b)) & 0xff;
		}
	const digest = md5(pcm);

	const out = new BitWriter();
	const frames: number[] = []; // sizes in bytes
	const mid = new Int32Array(blockSize);
	const side = new Int32Array(blockSize);
	const scratch = new Float64Array(blockSize);
	let number = 0;
	for (let start = 0; start < total; start += blockSize, number++) {
		const n = Math.min(blockSize, total - start);
		const l = L.subarray(start, start + n);
		const r = R.subarray(start, start + n);
		const m = mid.subarray(0, n);
		const sd = side.subarray(0, n);
		for (let i = 0; i < n; i++) {
			m[i] = (l[i] + r[i]) >> 1;
			sd[i] = l[i] - r[i];
		}
		// choose the stereo layout on the cheap estimates, then code only the two channels it keeps
		const al = analyse(l, bps, scratch);
		const ar = analyse(r, bps, scratch);
		const am = analyse(m, bps, scratch);
		const as = analyse(sd, bps + 1, scratch);
		const layouts = [
			{ code: 1, a: [l, bps, al], b: [r, bps, ar], bits: al.estimate + ar.estimate },
			{ code: 8, a: [l, bps, al], b: [sd, bps + 1, as], bits: al.estimate + as.estimate },
			{ code: 9, a: [sd, bps + 1, as], b: [r, bps, ar], bits: as.estimate + ar.estimate },
			{ code: 10, a: [m, bps, am], b: [sd, bps + 1, as], bits: am.estimate + as.estimate },
		] as const;
		const pick = layouts.reduce((x, y) => (y.bits < x.bits ? y : x));
		const first = encodeSubframe(pick.a[0], pick.a[1], scratch, pick.a[2]);
		const second = encodeSubframe(pick.b[0], pick.b[1], scratch, pick.b[2]);
		const frameStart = out.length;
		out.write(0xfff8, 16); // sync, fixed block size
		const code = BLOCK_CODES[n] ?? 7;
		out.write(code, 4);
		out.write(0, 4); // sample rate from STREAMINFO
		out.write(pick.code, 4);
		out.write(0, 4); // sample size from STREAMINFO (3 bits) and the reserved bit
		frameNumber(out, number);
		if (code === 7) out.write(n - 1, 16);
		out.write(crc8(out.take(), frameStart, out.length), 8);
		first.write(out);
		second.write(out);
		out.alignToByte();
		out.write(crc16(out.take(), frameStart, out.length), 16);
		frames.push(out.length - frameStart);
	}
	const body = out.take();

	// STREAMINFO is written last, once the frame sizes are known
	const info = new BitWriter();
	const largest = Math.max(16, Math.min(blockSize, total));
	info.write(largest, 16);
	info.write(largest, 16);
	info.write(frames.length ? Math.min(...frames) : 0, 24);
	info.write(frames.length ? Math.max(...frames) : 0, 24);
	info.write(sampleRate, 20);
	info.write(1, 3); // channels - 1
	info.write(bps - 1, 5);
	info.write(Math.floor(total / 2 ** 32), 4);
	info.write(total >>> 0, 32);
	const infoBytes = info.take();
	const comment = vorbisComment('mwg-retro-audio', options.tags ?? {});
	const head = new Uint8Array(4 + 4 + 34 + 4 + comment.length);
	head.set([0x66, 0x4c, 0x61, 0x43]); // "fLaC"
	head[4] = 0; // STREAMINFO, not the last block
	head[5] = 0;
	head[6] = 0;
	head[7] = 34;
	head.set(infoBytes, 8);
	head.set(digest, 8 + 18);
	head[42] = 0x80 | 4; // VORBIS_COMMENT, the last block
	head[43] = (comment.length >> 16) & 0xff;
	head[44] = (comment.length >> 8) & 0xff;
	head[45] = comment.length & 0xff;
	head.set(comment, 46);
	const file = new Uint8Array(head.length + body.length);
	file.set(head);
	file.set(body, head.length);
	return file;
}

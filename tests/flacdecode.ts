// A small FLAC decoder for the tests: it reads exactly what `encodeFlac` writes (constant, verbatim and fixed subframes,
// partitioned Rice residuals, the four stereo layouts) and checks the frame CRCs and the STREAMINFO MD5. It shares no
// code with the encoder, so a round trip through it is a real check.
import { createHash } from 'node:crypto';

class Bits {
	pos = 0;
	constructor(readonly b: Uint8Array) {}
	read(n: number): number {
		let v = 0;
		for (let i = 0; i < n; i++) {
			v = v * 2 + ((this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
			this.pos++;
		}
		return v;
	}
	signed(n: number): number {
		const v = this.read(n);
		return v >= 2 ** (n - 1) ? v - 2 ** n : v;
	}
	unary(): number {
		let n = 0;
		while (this.read(1) === 0) n++;
		return n;
	}
	align(): void {
		this.pos = (this.pos + 7) & ~7;
	}
}

function crc8(b: Uint8Array): number {
	let c = 0;
	for (const x of b) {
		c ^= x;
		for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
	}
	return c;
}

function crc16(b: Uint8Array): number {
	let c = 0;
	for (const x of b) {
		c ^= x << 8;
		for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
	}
	return c;
}

export interface DecodedFlac {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	totalSamples: number;
	/** interleaved integer samples */
	samples: Int32Array;
	md5Matches: boolean;
	comments: string[];
	blockSizes: number[];
}

export function decodeFlac(file: Uint8Array): DecodedFlac {
	const text = String.fromCharCode(...file.subarray(0, 4));
	if (text !== 'fLaC') throw new Error('not a FLAC file');
	let o = 4;
	let info: Uint8Array | null = null;
	const comments: string[] = [];
	for (let last = false; !last;) {
		const h = file[o];
		last = (h & 0x80) !== 0;
		const type = h & 0x7f;
		const len = (file[o + 1] << 16) | (file[o + 2] << 8) | file[o + 3];
		const body = file.subarray(o + 4, o + 4 + len);
		if (type === 0) info = body;
		if (type === 4) {
			const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
			let p = 4 + dv.getUint32(0, true);
			const count = dv.getUint32(p, true);
			p += 4;
			for (let i = 0; i < count; i++) {
				const l = dv.getUint32(p, true);
				comments.push(new TextDecoder().decode(body.subarray(p + 4, p + 4 + l)));
				p += 4 + l;
			}
		}
		o += 4 + len;
	}
	if (!info) throw new Error('no STREAMINFO');
	const ib = new Bits(info);
	ib.read(16);
	ib.read(16);
	ib.read(24);
	ib.read(24);
	const sampleRate = ib.read(20);
	const channels = ib.read(3) + 1;
	const bps = ib.read(5) + 1;
	const totalSamples = ib.read(36);
	const md5 = info.subarray(18, 34);
	const samples = new Int32Array(totalSamples * channels);
	const blockSizes: number[] = [];
	let at = 0;
	while (o < file.length) {
		const start = o;
		const br = new Bits(file.subarray(o));
		if (br.read(14) !== 0x3ffe) throw new Error(`bad frame sync at ${o}`);
		br.read(2);
		const bsCode = br.read(4);
		br.read(4);
		const chCode = br.read(4);
		br.read(4);
		const lead = br.read(8);
		let extra = 0;
		if (lead >= 0xc0) while (lead & (0x80 >> (extra + 1))) extra++;
		for (let i = 0; i < extra; i++) br.read(8);
		const sizes: Record<number, number> = {
			1: 192,
			2: 576,
			3: 1152,
			4: 2304,
			5: 4608,
			8: 256,
			9: 512,
			10: 1024,
			11: 2048,
			12: 4096,
			13: 8192,
			14: 16384,
			15: 32768,
		};
		const n = bsCode === 7 ? br.read(16) + 1 : sizes[bsCode];
		const headerEnd = br.pos >> 3;
		if (crc8(file.subarray(o, o + headerEnd)) !== br.read(8)) throw new Error('frame header CRC mismatch');
		const kinds = chCode === 1 ? [0, 0] : chCode === 8 ? [0, 1] : chCode === 9 ? [1, 0] : [0, 1];
		const chans: Int32Array[] = [];
		for (let c = 0; c < 2; c++) {
			const sbps = bps + (kinds[c] === 1 ? 1 : 0);
			br.read(1);
			const type = br.read(6);
			br.read(1);
			const s = new Int32Array(n);
			if (type === 0) s.fill(br.signed(sbps));
			else if (type === 1) for (let i = 0; i < n; i++) s[i] = br.signed(sbps);
			else if (type >= 8 && type <= 12) {
				const order = type - 8;
				for (let i = 0; i < order; i++) s[i] = br.signed(sbps);
				if (br.read(2) !== 0) throw new Error('only 4 bit Rice parameters are written');
				const po = br.read(4);
				const parts = 2 ** po;
				for (let p = 0; p < parts; p++) {
					const k = br.read(4);
					const from = p === 0 ? order : p * (n >> po);
					for (let i = from; i < (p + 1) * (n >> po); i++) {
						const u = br.unary() * 2 ** k + (k ? br.read(k) : 0);
						const r = u % 2 === 0 ? u / 2 : -(u + 1) / 2;
						const a = (d: number) => (i - d >= 0 ? s[i - d] : 0);
						const pred = [
							0,
							a(1),
							2 * a(1) - a(2),
							3 * a(1) - 3 * a(2) + a(3),
							4 * a(1) - 6 * a(2) + 4 * a(3) - a(4),
						][order];
						s[i] = pred + r;
					}
				}
			} else throw new Error(`unsupported subframe type ${type}`);
			chans.push(s);
		}
		br.align();
		const end = br.pos >> 3;
		if (crc16(file.subarray(o, o + end)) !== br.read(16)) throw new Error('frame CRC mismatch');
		const [a, b] = chans;
		for (let i = 0; i < n; i++) {
			let l = a[i];
			let r = b[i];
			if (chCode === 8) r = a[i] - b[i];
			else if (chCode === 9) {
				r = b[i];
				l = a[i] + b[i];
			} else if (chCode === 10) {
				const side = b[i];
				const mid = (a[i] << 1) | (side & 1);
				l = (mid + side) >> 1;
				r = (mid - side) >> 1;
			}
			samples[(at + i) * 2] = l;
			samples[(at + i) * 2 + 1] = r;
		}
		blockSizes.push(n);
		at += n;
		o = start + end + 2;
	}
	const width = bps / 8;
	const pcm = new Uint8Array(totalSamples * channels * width);
	for (let i = 0; i < samples.length; i++)
		for (let b = 0; b < width; b++) pcm[i * width + b] = (samples[i] >> (8 * b)) & 0xff;
	const md5Matches = createHash('md5').update(pcm).digest('hex') === Buffer.from(md5).toString('hex');
	return { sampleRate, channels, bitsPerSample: bps, totalSamples, samples, md5Matches, comments, blockSizes };
}

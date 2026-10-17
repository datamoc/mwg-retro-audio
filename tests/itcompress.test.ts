import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompressItSample, parseIt } from '../src/formats/tracker/it.ts';
import { buildIt } from './xmitfile.ts';

// A compressor written from the published description of the IT214 / IT215 scheme (8 bit samples): it chooses the
// narrowest bit width that holds each delta and signals every width change with the marker of the current width
// class. The decoder under test must read back exactly what it was given.
class BitWriter {
	bytes: number[] = [];
	private cur = 0;
	private n = 0;
	put(value: number, bits: number): void {
		for (let i = 0; i < bits; i++) {
			this.cur |= ((value >> i) & 1) << this.n;
			if (++this.n === 8) {
				this.bytes.push(this.cur);
				this.cur = this.n = 0;
			}
		}
	}
	flush(): number[] {
		if (this.n) this.bytes.push(this.cur);
		return this.bytes;
	}
}

function reserved(value: number, w: number): boolean {
	if (w >= 9) return value & 0x100 ? true : false;
	if (w < 7) return value === 1 << (w - 1);
	const border = (0xff >> (9 - w)) - 4;
	return value > border && value <= border + 8;
}

function narrowest(delta: number): number {
	for (let w = 2; w <= 9; w++) {
		const mask = w === 9 ? 0xff : (1 << w) - 1;
		const lo = w === 9 ? -128 : -(1 << (w - 1));
		const hi = w === 9 ? 127 : (1 << (w - 1)) - 1;
		if (delta < lo || delta > hi) continue;
		const pattern = w === 9 ? delta & 0xff : delta & mask;
		if (!reserved(pattern, w)) return w;
	}
	return 9;
}

function compress(samples: Int8Array, it215: boolean): number[] {
	const out: number[] = [];
	for (let start = 0; start < samples.length; start += 0x8000) {
		const block = samples.subarray(start, start + 0x8000);
		const bw = new BitWriter();
		let width = 9;
		let d1 = 0;
		let d2 = 0;
		for (const s of block) {
			const value = ((it215 ? s - d2 - d1 : s - d1) << 24) >> 24;
			const w = narrowest(value);
			if (w !== width) {
				if (width < 7) {
					bw.put(1 << (width - 1), width);
					bw.put(w < width ? w - 1 : w - 2, 3);
				} else if (width < 9) {
					const border = (0xff >> (9 - width)) - 4;
					bw.put(border + (w < width ? w : w - 1), width);
				} else bw.put(0x100 | (w - 1), 9);
				width = w;
			}
			bw.put(width === 9 ? value & 0xff : value & ((1 << width) - 1), width);
			d1 += value;
			d1 = (d1 << 24) >> 24;
			d2 += d1;
			d2 = (d2 << 24) >> 24;
		}
		const bytes = bw.flush();
		out.push(bytes.length & 255, bytes.length >> 8, ...bytes);
	}
	return out;
}

const signal = (n: number): Int8Array =>
	Int8Array.from({ length: n }, (_, i) => {
		// quiet start, loud middle, noise burst, quiet end: forces width changes in both directions
		const env = i < n / 4 ? 3 : i < n / 2 ? 100 : i < (3 * n) / 4 ? 40 : 2;
		const noise = i % 7 === 0 ? (((i * 2654435761) >>> 24) % 41) - 20 : 0;
		return Math.round(env * Math.sin(i / 9) + noise);
	});

test('IT214 and IT215 decompression reads back what a compressor following the published scheme wrote', () => {
	for (const it215 of [false, true]) {
		const data = signal(5000);
		const packed = compress(data, it215);
		const out = decompressItSample(Uint8Array.from(packed), 0, data.length, false, it215);
		assert.equal(out.length, data.length);
		for (let i = 0; i < data.length; i++)
			assert.equal(Math.round(out[i] * 128), data[i], `sample ${i} (it215=${it215})`);
	}
});

test('a compressed sample inside an IT file is decoded when the file is parsed', () => {
	const data = signal(2000);
	const bytes = buildIt({
		rows: [[{ note: 60, instrument: 1 }]],
		sample: data,
		sampleBytes: compress(data, false),
		sampleFlags: 1 | 8 | 16,
		cvt: 1,
		cmwt: 0x214,
	});
	const song = parseIt(bytes);
	const s = song.instruments[0].samples[0];
	assert.equal(s.data.length, 2000);
	assert.equal(Math.round(s.data[1500] * 128), data[1500]);
	const packed215 = buildIt({
		rows: [[{ note: 60, instrument: 1 }]],
		sample: data,
		sampleBytes: compress(data, true),
		sampleFlags: 1 | 8 | 16,
		cvt: 5,
		cmwt: 0x215,
	});
	assert.equal(Math.round(parseIt(packed215).instruments[0].samples[0].data[1500] * 128), data[1500]);
});

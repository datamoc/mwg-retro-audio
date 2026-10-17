// An Ogg reader for the tests: pages, their CRC, and the packets reassembled from the lacing values.
import { oggCrc } from '../src/driver/ogg.ts';

export interface OggPage {
	type: number;
	granule: number;
	serial: number;
	sequence: number;
	crcOk: boolean;
	packets: Uint8Array[];
	/** true when the last packet continues on the next page */
	open: boolean;
}

export function parseOgg(bytes: Uint8Array): OggPage[] {
	const pages: OggPage[] = [];
	let o = 0;
	let carry: Uint8Array[] = [];
	while (o < bytes.length) {
		if (String.fromCharCode(...bytes.subarray(o, o + 4)) !== 'OggS') throw new Error(`no capture pattern at ${o}`);
		const dv = new DataView(bytes.buffer, bytes.byteOffset + o);
		const nseg = bytes[o + 26];
		const lacing = bytes.subarray(o + 27, o + 27 + nseg);
		const size = lacing.reduce((s, v) => s + v, 0);
		const total = 27 + nseg + size;
		const raw = Uint8Array.from(bytes.subarray(o, o + total));
		const stored = new DataView(raw.buffer).getUint32(22, true);
		new DataView(raw.buffer).setUint32(22, 0, true);
		const packets: Uint8Array[] = [];
		let p = o + 27 + nseg;
		let cur: Uint8Array[] = carry;
		carry = [];
		let open = false;
		lacing.forEach((l, i) => {
			cur.push(bytes.subarray(p, p + l));
			p += l;
			if (l < 255) {
				const len = cur.reduce((s, c) => s + c.length, 0);
				const joined = new Uint8Array(len);
				let q = 0;
				for (const c of cur) {
					joined.set(c, q);
					q += c.length;
				}
				packets.push(joined);
				cur = [];
			} else if (i === lacing.length - 1) open = true;
		});
		if (open) carry = cur;
		pages.push({
			type: bytes[o + 5],
			granule: dv.getUint32(6, true) + dv.getUint32(10, true) * 2 ** 32,
			serial: dv.getUint32(14, true),
			sequence: dv.getUint32(18, true),
			crcOk: oggCrc(raw) === stored,
			packets,
			open,
		});
		o += total;
	}
	return pages;
}

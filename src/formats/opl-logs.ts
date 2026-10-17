import type { MwaData } from './mwa.ts';

/**
 * Register logs of the OPL: DOSBox raw captures (`.dro`, versions 0.1 and 2.0) and id Software Music Format
 * (`.imf` / `.wlf`, types 0 and 1). Both are plain timed register writes, so they are turned into `MwaData` and
 * played by `MwaPlayer` like every other source.
 */

const TIMEBASE = 44100;

const empty = (chips: MwaData['chips'], frameRate: number): MwaData & { n: number } => ({
	timebase: TIMEBASE,
	frameRate,
	title: '',
	author: '',
	comment: '',
	chips,
	time: new Float64Array(0),
	chip: new Uint8Array(0),
	addr: new Uint16Array(0),
	value: new Uint8Array(0),
	length: 0,
	loopStart: -1,
	blobs: [],
	n: 0,
});

export class EventLog {
	private t: number[] = [];
	private c: number[] = [];
	private a: number[] = [];
	private v: number[] = [];
	time = 0; // in ticks
	push(chip: number, addr: number, value: number): void {
		this.t.push(this.time);
		this.c.push(chip);
		this.a.push(addr);
		this.v.push(value);
	}
	build(chips: MwaData['chips'], frameRate: number, comment: string): MwaData {
		const d = empty(chips, frameRate);
		return {
			...d,
			comment,
			time: Float64Array.from(this.t),
			chip: Uint8Array.from(this.c),
			addr: Uint16Array.from(this.a),
			value: Uint8Array.from(this.v),
			length: Math.round(this.time),
		};
	}
}

export function isDro(bytes: Uint8Array): boolean {
	return bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 8)) === 'DBRAWOPL';
}

const OPL2_CLOCK = 3_579_545;
const OPL3_CLOCK = 14_318_180;

/** Parse a DOSBox raw OPL capture (`.dro`, v0.1 and v2.0) */
export function parseDro(b: Uint8Array): MwaData {
	if (!isDro(b)) throw new Error('not a DRO file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const major = v.getUint16(8, true);
	const minor = v.getUint16(10, true);
	const log = new EventLog();
	const msToTicks = TIMEBASE / 1000;
	if (major === 0 && minor === 1) {
		const hw = b[0x14];
		let start = 0x18;
		const lengthBytes = v.getUint32(0x10, true);
		if (b[0x15] || b[0x16] || b[0x17]) start = 0x15; // early files: the hardware type is one byte only
		const end = Math.min(b.length, start + lengthBytes);
		// v0.1 hardware: 0 OPL2, 1 OPL3, 2 dual OPL2
		const chips: MwaData['chips'] =
			hw === 1
				? [{ id: 'opl3', clock: OPL3_CLOCK }]
				: hw === 2
					? [
							{ id: 'opl2', clock: OPL2_CLOCK },
							{ id: 'opl2', clock: OPL2_CLOCK },
						]
					: [{ id: 'opl2', clock: OPL2_CLOCK }];
		let sel = 0;
		for (let p = start; p < end;) {
			const code = b[p++];
			if (code === 0) log.time += (b[p++] + 1) * msToTicks;
			else if (code === 1) {
				log.time += (b[p] + (b[p + 1] << 8) + 1) * msToTicks;
				p += 2;
			} else if (code === 2) sel = 0;
			else if (code === 3) sel = 1;
			else if (code === 4) {
				log.push(sel, b[p], b[p + 1]);
				p += 2;
			} else {
				log.push(sel, code, b[p++]);
			}
		}
		// OPL3 files address the second register bank with the "high chip" selector
		if (hw === 1) remapBanks(log);
		return log.build(chips, 60, 'DRO 0.1');
	}
	if (major === 2) {
		const pairs = v.getUint32(0x0c, true);
		const hw = b[0x14];
		const shortCode = b[0x17];
		const longCode = b[0x18];
		const mapLen = b[0x19];
		const map = b.subarray(0x1a, 0x1a + mapLen);
		// v2 hardware: 0 OPL2, 1 dual OPL2, 2 OPL3
		const chips: MwaData['chips'] =
			hw === 2
				? [{ id: 'opl3', clock: OPL3_CLOCK }]
				: hw === 1
					? [
							{ id: 'opl2', clock: OPL2_CLOCK },
							{ id: 'opl2', clock: OPL2_CLOCK },
						]
					: [{ id: 'opl2', clock: OPL2_CLOCK }];
		let p = 0x1a + mapLen;
		for (let i = 0; i < pairs && p + 1 < b.length; i++, p += 2) {
			const idx = b[p];
			const val = b[p + 1];
			if (idx === shortCode) log.time += (val + 1) * msToTicks;
			else if (idx === longCode) log.time += (val + 1) * 256 * msToTicks;
			else {
				const second = (idx & 0x80) !== 0;
				const reg = map[idx & 0x7f] ?? 0;
				if (hw === 2) log.push(0, (second ? 0x100 : 0) | reg, val);
				else log.push(second && hw === 1 ? 1 : 0, reg, val);
			}
		}
		return log.build(chips, 60, 'DRO 2.0');
	}
	throw new Error(`unsupported DRO version ${major}.${minor}`);
}

/** DRO 0.1 on an OPL3 uses chip selector 1 for the second bank: fold it into 0x100 + register */
function remapBanks(log: EventLog): void {
	const l = log as unknown as { c: number[]; a: number[] };
	for (let i = 0; i < l.c.length; i++) {
		if (l.c[i] === 1) {
			l.c[i] = 0;
			l.a[i] |= 0x100;
		}
	}
}

/**
 * Parse an IMF file. `ticksPerSecond` is the rate of the delay counter: 560 Hz for Wolfenstein 3D / Blake Stone,
 * 700 Hz for most id Software DOS games (Commander Keen, Bio Menace) and 280 Hz for some others.
 * Type 1 files start with the byte length of the music data; type 0 files start directly with the data.
 */
export function parseImf(b: Uint8Array, ticksPerSecond = 560): MwaData {
	let start = 0;
	let end = b.length;
	const first = b[0] | (b[1] << 8);
	if (first !== 0) {
		start = 2;
		end = Math.min(b.length, 2 + first);
	}
	const log = new EventLog();
	for (let p = start; p + 3 < end + 1 && p + 3 < b.length; p += 4) {
		log.push(0, b[p], b[p + 1]);
		const delay = b[p + 2] | (b[p + 3] << 8);
		log.time += (delay * TIMEBASE) / ticksPerSecond;
	}
	const d = log.build([{ id: 'opl2', clock: OPL2_CLOCK }], ticksPerSecond, `IMF ${ticksPerSecond} Hz`);
	// type 1 files may carry a title/author tag after the data
	if (end < b.length - 4 && b[end] === 0x1a) {
		const text = new TextDecoder('latin1').decode(b.subarray(end + 1)).split('\0');
		d.title = text[0] ?? '';
		d.author = text[1] ?? '';
	}
	return d;
}

/** minimal sanity test for IMF data (the format has no magic number) */
export function looksLikeImf(b: Uint8Array): boolean {
	if (b.length < 8) return false;
	const first = b[0] | (b[1] << 8);
	if (first === 0) return b.length % 4 === 0;
	return first % 4 === 0 && first + 2 <= b.length && first >= 4;
}

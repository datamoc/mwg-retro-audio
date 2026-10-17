import { ModulePlayer, type ModuleOptions } from './player.ts';
import {
	makeEnvelope,
	type Cell,
	type Envelope,
	type Instrument,
	type Pattern,
	type Sample,
	type TrackerSong,
} from './types.ts';

export function isIt(b: Uint8Array): boolean {
	return b.length > 192 && String.fromCharCode(...b.subarray(0, 4)) === 'IMPM';
}

const text = (b: Uint8Array, o: number, n: number): string =>
	String.fromCharCode(...b.subarray(o, o + n))
		.replace(/\0.*$/, '')
		.trimEnd();

/** LSB first bit reader of the IT sample compression */
class Bits {
	private pos = 0;
	private cur = 0;
	private n = 0;
	constructor(private readonly d: Uint8Array) {}
	read(bits: number): number {
		let v = 0;
		for (let i = 0; i < bits; i++) {
			if (this.n === 0) {
				this.cur = this.d[this.pos++] ?? 0;
				this.n = 8;
			}
			v |= (this.cur & 1) << i;
			this.cur >>= 1;
			this.n--;
		}
		return v;
	}
}

/** IT214 / IT215 compressed sample (8 or 16 bit), following the published algorithm of Impulse Tracker */
export function decompressItSample(
	src: Uint8Array,
	start: number,
	length: number,
	wide: boolean,
	it215: boolean,
): Float32Array {
	const out = new Float32Array(length);
	let p = start;
	let done = 0;
	const blockMax = wide ? 0x4000 : 0x8000;
	while (done < length && p + 2 <= src.length) {
		const size = src[p] | (src[p + 1] << 8);
		p += 2;
		const br = new Bits(src.subarray(p, p + size));
		p += size;
		const count = Math.min(blockMax, length - done);
		let width = wide ? 17 : 9;
		let d1 = 0;
		let d2 = 0;
		for (let i = 0; i < count;) {
			let value = br.read(width);
			if (width < 7) {
				if (value === 1 << (width - 1)) {
					const nw = br.read(wide ? 4 : 3) + 1;
					width = nw < width ? nw : nw + 1;
					continue;
				}
			} else if (width < (wide ? 17 : 9)) {
				const border = (wide ? 0xffff >> (17 - width) : 0xff >> (9 - width)) - (wide ? 8 : 4);
				if (value > border && value <= border + (wide ? 16 : 8)) {
					const nw = value - border;
					width = nw < width ? nw : nw + 1;
					continue;
				}
			} else {
				if (value & (wide ? 0x10000 : 0x100)) {
					width = (value + 1) & 0xff;
					continue;
				}
			}
			// sign extend from `width` bits
			let v: number;
			if (width < (wide ? 16 : 8)) {
				const shift = (wide ? 16 : 8) - width;
				v = wide ? (((value << shift) << 16) >> 16) >> shift : (((value << shift) << 24) >> 24) >> shift;
			} else v = wide ? (value << 16) >> 16 : (value << 24) >> 24;
			value = v;
			d1 += value;
			d2 += d1;
			const sample = it215 ? d2 : d1;
			out[done + i] = wide ? ((sample << 16) >> 16) / 32768 : ((sample << 24) >> 24) / 128;
			i++;
		}
		done += count;
	}
	return out;
}

function envelope(b: Uint8Array, o: number, isPan: boolean): Envelope {
	const flags = b[o];
	const n = Math.min(25, b[o + 1]);
	const pts: { tick: number; value: number }[] = [];
	for (let i = 0; i < n; i++) {
		const y = (b[o + 6 + i * 3] << 24) >> 24;
		pts.push({ tick: b[o + 7 + i * 3] | (b[o + 8 + i * 3] << 8), value: isPan ? y + 32 : y });
	}
	return makeEnvelope(
		pts,
		{ on: (flags & 1) !== 0, loop: (flags & 2) !== 0, sustain: (flags & 4) !== 0 },
		b[o + 4],
		b[o + 5],
		b[o + 2],
		b[o + 3],
	);
}

/** IT effect letter number (A = 1) -> FastTracker numbering used by the engine; returns [effect, param] */
export function translateEffect(cmd: number, param: number): [number, number] {
	const x = param >> 4;
	const y = param & 15;
	switch (cmd) {
		case 1:
			return [0xf, param > 0 && param < 32 ? param : Math.min(31, param)]; // A: set speed
		case 2:
			return [0xb, param];
		case 3:
			return [0xd, param];
		case 4: // D: volume slide with the fine variants coded in the nibbles
			if (y === 0xf && x !== 0) return [0xe, 0xa0 | x];
			if (x === 0xf && y !== 0) return [0xe, 0xb0 | y];
			return [0xa, param];
		case 5: // E: slide down
			if (x === 0xf) return [0xe, 0x20 | y];
			if (x === 0xe) return [0x21, 0x20 | y];
			return [2, param];
		case 6: // F: slide up
			if (x === 0xf) return [0xe, 0x10 | y];
			if (x === 0xe) return [0x21, 0x10 | y];
			return [1, param];
		case 7:
			return [3, param];
		case 8:
			return [4, param];
		case 9:
			return [0x1d, param];
		case 10:
			return [0, param];
		case 11:
			return [6, param];
		case 12:
			return [5, param];
		case 13:
			return [0x30, Math.min(64, param)];
		case 15:
			return [9, param];
		case 16:
			return [0x19, param];
		case 17:
			return [0x1b, param];
		case 18:
			return [7, param];
		case 19: // S: sub commands
			switch (x) {
				case 0x3:
					return [0xe, 0x40 | y];
				case 0x4:
					return [0xe, 0x70 | y];
				case 0x8:
					return [0xe, 0x80 | y];
				case 0xb:
					return [0xe, 0x60 | y];
				case 0xc:
					return [0xe, 0xc0 | y];
				case 0xd:
					return [0xe, 0xd0 | y];
				case 0xe:
					return [0xe, 0xe0 | y];
				default:
					return [0, 0];
			}
		case 20:
			return param >= 0x20 ? [0xf, param] : [0, 0]; // T: tempo (slides are not supported)
		case 21:
			return [4, (x << 4) | Math.max(1, y >> 2)]; // U: fine vibrato
		case 22:
			return [0x10, Math.min(64, param >> 1)];
		case 23:
			return [0x11, param];
		case 24:
			return [8, param];
		default:
			return [0, 0];
	}
}

/** volume / panning column of IT converted to the XM volume column encoding */
export function translateVolume(v: number): number {
	if (v <= 64) return 0x10 + v;
	if (v <= 74) return 0x90 | (v - 65);
	if (v <= 84) return 0x80 | (v - 75);
	if (v <= 94) return 0x70 | (v - 85);
	if (v <= 104) return 0x60 | (v - 95);
	if (v >= 128 && v <= 192) return 0xc0 | Math.round(((v - 128) * 15) / 64);
	if (v >= 193 && v <= 202) return 0xf0 | Math.min(15, [0, 1, 4, 8, 16, 32, 64, 96, 128, 255][v - 193] >> 4 || 1);
	if (v >= 203 && v <= 212) return 0xb0 | (v - 203);
	return 0;
}

/**
 * Parse an Impulse Tracker `.it` (instrument mode with the 0x200 format, sample mode, compressed samples).
 * Not supported: old (cmwt < 0x200) instruments, stereo sample panning details, filter envelopes, panbrello and MIDI
 * macros; Amiga-slide files are played with the linear frequency table (see CONFORMANCE.md).
 */
export function parseIt(b: Uint8Array): TrackerSong {
	if (!isIt(b)) throw new Error('not an IT file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const title = text(b, 4, 26);
	const ordNum = v.getUint16(0x20, true);
	const insNum = v.getUint16(0x22, true);
	const smpNum = v.getUint16(0x24, true);
	const patNum = v.getUint16(0x26, true);
	const cmwt = v.getUint16(0x2a, true);
	const flags = v.getUint16(0x2c, true);
	const globalVol = b[0x30];
	const speed = b[0x32] || 6;
	const tempo = b[0x33] || 125;
	const useInstruments = (flags & 4) !== 0;
	const defaultPan = Array.from({ length: 64 }, (_, i) => (b[0x40 + i] <= 64 ? Math.min(255, b[0x40 + i] * 4) : 128));
	const channelVolume = Array.from({ length: 64 }, (_, i) => Math.min(64, b[0x80 + i]));
	const orders = Array.from(b.subarray(0xc0, 0xc0 + ordNum)).filter((o) => o < 254);
	let q = 0xc0 + ordNum;
	const insOffsets = Array.from({ length: insNum }, (_, i) => v.getUint32(q + i * 4, true));
	q += insNum * 4;
	const smpOffsets = Array.from({ length: smpNum }, (_, i) => v.getUint32(q + i * 4, true));
	q += smpNum * 4;
	const patOffsets = Array.from({ length: patNum }, (_, i) => v.getUint32(q + i * 4, true));

	// samples
	const samples: Sample[] = smpOffsets.map((o) => {
		if (o === 0 || String.fromCharCode(...b.subarray(o, o + 4)) !== 'IMPS') {
			return {
				name: '',
				data: new Float32Array(0),
				loopType: 0,
				loopStart: 0,
				loopEnd: 0,
				volume: 64,
				finetune: 0,
				relativeNote: 0,
				baseFreq: 8363,
				pan: -1,
			};
		}
		const flag = b[o + 0x12];
		const vol = b[o + 0x13];
		const cvt = b[o + 0x2e];
		const dfp = b[o + 0x2f];
		const length = v.getUint32(o + 0x30, true);
		const loopBegin = v.getUint32(o + 0x34, true);
		const loopEnd = v.getUint32(o + 0x38, true);
		const c5 = v.getUint32(o + 0x3c, true) || 8363;
		const ptr = v.getUint32(o + 0x48, true);
		const wide = (flag & 2) !== 0;
		const stereo = (flag & 4) !== 0;
		const compressed = (flag & 8) !== 0;
		let data: Float32Array = new Float32Array(0);
		if (flag & 1 && length > 0) {
			if (compressed) data = decompressItSample(b, ptr, length, wide, cmwt >= 0x215 && (cvt & 4) !== 0);
			else {
				data = new Float32Array(length);
				const signed = (cvt & 1) !== 0;
				const step = (wide ? 2 : 1) * (stereo ? 2 : 1);
				for (let i = 0; i < length; i++) {
					const at = ptr + i * step;
					if (wide) data[i] = (signed ? v.getInt16(at, true) : v.getUint16(at, true) - 32768) / 32768;
					else data[i] = (signed ? (b[at] << 24) >> 24 : b[at] - 128) / 128;
				}
			}
		}
		const loops = (flag & 16) !== 0;
		const vibType = [0, 1, 2, 3][b[o + 0x4e] & 3];
		return {
			name: text(b, o + 0x14, 26),
			data,
			loopType: loops ? ((flag & 64) !== 0 ? 2 : 1) : 0,
			loopStart: Math.min(loopBegin, data.length),
			loopEnd: Math.min(loopEnd, data.length),
			volume: Math.min(64, vol),
			finetune: 0,
			relativeNote: 0,
			baseFreq: c5,
			pan: dfp & 128 ? (dfp & 127) * 4 : -1,
			vibrato: {
				type: vibType,
				sweep: b[o + 0x4b] ? Math.round(256 / b[o + 0x4b]) : 0,
				depth: b[o + 0x4c],
				rate: b[o + 0x4d],
			},
		};
	});

	let instruments: Instrument[];
	if (useInstruments) {
		instruments = insOffsets.map((o) => {
			if (o === 0 || cmwt < 0x200 || String.fromCharCode(...b.subarray(o, o + 4)) !== 'IMPI')
				return { name: '', samples: [], fadeout: 0 };
			const map = new Uint8Array(120);
			const used: number[] = [];
			const local: Sample[] = [];
			for (let n = 0; n < 120; n++) {
				const smp = b[o + 0x41 + n * 2];
				const idx = smp > 0 ? smp - 1 : 0;
				let li = used.indexOf(idx);
				if (li < 0) {
					used.push(idx);
					local.push(samples[idx] ?? samples[0]);
					li = used.length - 1;
				}
				map[n] = li;
			}
			const inst: Instrument = {
				name: text(b, o + 0x20, 26),
				samples: local,
				sampleMap: map,
				fadeout: v.getUint16(o + 0x14, true) * 32,
				nna: b[o + 0x11],
				volEnv: envelope(b, o + 0x130, false),
				panEnv: envelope(b, o + 0x182, true),
			};
			return inst;
		});
	} else {
		instruments = samples.map((s) => ({ name: s.name, samples: [s], fadeout: 0 }));
	}

	// patterns
	const patterns: Pattern[] = patOffsets.map((o) => {
		if (o === 0)
			return {
				rows: 64,
				cells: Array.from({ length: 64 }, () =>
					Array.from({ length: 64 }, () => ({ note: 0, instrument: 0, volume: 0, effect: 0, param: 0 })),
				),
			};
		const rows = v.getUint16(o + 2, true);
		const len = v.getUint16(o, true);
		let p = o + 8;
		const end = p + len;
		const cells: Cell[][] = Array.from({ length: rows }, () =>
			Array.from({ length: 64 }, () => ({ note: 0, instrument: 0, volume: 0, effect: 0, param: 0 })),
		);
		const lastMask = new Uint8Array(64);
		const lastNote = new Uint8Array(64);
		const lastIns = new Uint8Array(64);
		const lastVol = new Uint8Array(64);
		const lastCmd = new Uint8Array(64);
		const lastParam = new Uint8Array(64);
		let row = 0;
		while (row < rows && p < end) {
			const cv = b[p++];
			if (cv === 0) {
				row++;
				continue;
			}
			const ch = (cv - 1) & 63;
			let mask = lastMask[ch];
			if (cv & 128) mask = lastMask[ch] = b[p++];
			const cell = cells[row][ch];
			let note = 0;
			let vol = 0;
			let cmd = 0;
			let prm = 0;
			if (mask & 1) note = lastNote[ch] = b[p++];
			else if (mask & 16) note = lastNote[ch];
			if (mask & 2) cell.instrument = lastIns[ch] = b[p++];
			else if (mask & 32) cell.instrument = lastIns[ch];
			if (mask & 4) vol = lastVol[ch] = b[p++];
			else if (mask & 64) vol = lastVol[ch];
			if (mask & 8) {
				cmd = lastCmd[ch] = b[p++];
				prm = lastParam[ch] = b[p++];
			} else if (mask & 128) {
				cmd = lastCmd[ch];
				prm = lastParam[ch];
			}
			if (mask & (1 | 16)) cell.note = note === 255 ? 255 : note === 254 ? 254 : note < 120 ? note + 1 : 0;
			cell.volume = mask & (4 | 64) ? translateVolume(vol) : 0;
			const [e, pr] = translateEffect(cmd, prm);
			cell.effect = e;
			cell.param = pr;
		}
		return { rows, cells };
	});
	// the engine plays every channel the file declares: find the highest used channel
	let channels = 1;
	for (const pat of patterns)
		for (const row of pat.cells)
			for (let c = 0; c < 64; c++) {
				const cell = row[c];
				if (cell && (cell.note || cell.instrument || cell.volume || cell.effect) && c + 1 > channels)
					channels = c + 1;
			}
	for (const pat of patterns) pat.cells = pat.cells.map((r) => r.slice(0, channels));
	return {
		format: 'it',
		title,
		channels,
		patterns,
		order: orders,
		restartPosition: 0,
		initialSpeed: speed,
		initialTempo: tempo,
		amiga: false,
		linear: true,
		instruments,
		defaultPan: defaultPan.slice(0, channels),
		channelVolume: channelVolume.slice(0, channels),
		globalVolume: Math.min(64, globalVol >> 1),
		itOldEffects: (flags & 16) !== 0,
		comment:
			instruments
				.map((i) => i.name)
				.filter(Boolean)
				.join('\n') || undefined,
	};
}

export function loadIt(bytes: Uint8Array, options: ModuleOptions = {}): ModulePlayer {
	return new ModulePlayer(parseIt(bytes), options);
}

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

export function isXm(b: Uint8Array): boolean {
	return b.length > 336 && String.fromCharCode(...b.subarray(0, 17)) === 'Extended Module: ';
}

const text = (b: Uint8Array, o: number, n: number): string =>
	String.fromCharCode(...b.subarray(o, o + n))
		.replace(/\0.*$/, '')
		.trimEnd();

/** Parse a FastTracker 2 `.xm` (version 1.04; older 1.02 / 1.03 patterns are read with the same layout) */
export function parseXm(b: Uint8Array): TrackerSong {
	if (!isXm(b)) throw new Error('not an XM file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const title = text(b, 17, 20);
	const headerSize = v.getUint32(60, true);
	const songLength = v.getUint16(64, true);
	const restart = v.getUint16(66, true);
	const channels = v.getUint16(68, true);
	const nPatterns = v.getUint16(70, true);
	const nInstruments = v.getUint16(72, true);
	const flags = v.getUint16(74, true);
	const speed = v.getUint16(76, true) || 6;
	const tempo = v.getUint16(78, true) || 125;
	const order = Array.from(b.subarray(80, 80 + Math.min(256, songLength)));
	let p = 60 + headerSize;

	const patterns: Pattern[] = [];
	for (let n = 0; n < nPatterns; n++) {
		const hlen = v.getUint32(p, true);
		const rows = v.getUint16(p + 5, true);
		const psize = v.getUint16(p + 7, true);
		p += hlen;
		const cells: Cell[][] = [];
		let q = p;
		for (let r = 0; r < rows; r++) {
			const row: Cell[] = [];
			for (let c = 0; c < channels; c++) {
				const cell: Cell = { note: 0, instrument: 0, volume: 0, effect: 0, param: 0 };
				if (psize > 0) {
					const first = b[q++];
					if (first & 0x80) {
						if (first & 1) cell.note = b[q++];
						if (first & 2) cell.instrument = b[q++];
						if (first & 4) cell.volume = b[q++];
						if (first & 8) cell.effect = b[q++];
						if (first & 16) cell.param = b[q++];
					} else {
						cell.note = first;
						cell.instrument = b[q++];
						cell.volume = b[q++];
						cell.effect = b[q++];
						cell.param = b[q++];
					}
					// pattern break is stored in BCD
					if (cell.effect === 0xd) cell.param = (cell.param >> 4) * 10 + (cell.param & 15);
				}
				row.push(cell);
			}
			cells.push(row);
		}
		p += psize;
		patterns.push({ rows, cells });
	}

	const instruments: Instrument[] = [];
	for (let n = 0; n < nInstruments; n++) {
		const size = v.getUint32(p, true);
		const name = text(b, p + 4, 22);
		const count = v.getUint16(p + 27, true);
		const inst: Instrument = { name, samples: [], fadeout: 0 };
		if (count > 0 && size >= 243) {
			const sampleHeader = v.getUint32(p + 29, true);
			inst.sampleMap = b.slice(p + 33, p + 33 + 96);
			const readEnv = (at: number, nPoints: number): { tick: number; value: number }[] => {
				const pts: { tick: number; value: number }[] = [];
				for (let i = 0; i < Math.min(12, nPoints); i++)
					pts.push({ tick: v.getUint16(at + i * 4, true), value: v.getUint16(at + i * 4 + 2, true) });
				return pts;
			};
			const nVol = b[p + 225];
			const nPan = b[p + 226];
			const volType = b[p + 233];
			const panType = b[p + 234];
			const mk = (
				pts: { tick: number; value: number }[],
				type: number,
				sus: number,
				ls: number,
				le: number,
			): Envelope =>
				makeEnvelope(
					pts,
					{ on: (type & 1) !== 0, sustain: (type & 2) !== 0, loop: (type & 4) !== 0 },
					sus,
					sus,
					ls,
					le,
				);
			inst.volEnv = mk(readEnv(p + 129, nVol), volType, b[p + 227], b[p + 228], b[p + 229]);
			inst.panEnv = mk(readEnv(p + 177, nPan), panType, b[p + 230], b[p + 231], b[p + 232]);
			inst.vibrato = { type: b[p + 235], sweep: b[p + 236], depth: b[p + 237], rate: b[p + 238] };
			inst.fadeout = v.getUint16(p + 239, true);
			let q = p + size;
			const headers: {
				len: number;
				loopStart: number;
				loopLen: number;
				volume: number;
				finetune: number;
				type: number;
				pan: number;
				rel: number;
				name: string;
			}[] = [];
			for (let i = 0; i < count; i++) {
				const o = q + i * sampleHeader;
				headers.push({
					len: v.getUint32(o, true),
					loopStart: v.getUint32(o + 4, true),
					loopLen: v.getUint32(o + 8, true),
					volume: b[o + 12],
					finetune: (b[o + 13] << 24) >> 24,
					type: b[o + 14],
					pan: b[o + 15],
					rel: (b[o + 16] << 24) >> 24,
					name: text(b, o + 18, 22),
				});
			}
			q += count * sampleHeader;
			for (const h of headers) {
				const wide = (h.type & 16) !== 0;
				const frames = wide ? h.len >> 1 : h.len;
				const data = new Float32Array(frames);
				let acc = 0;
				for (let i = 0; i < frames; i++) {
					if (wide) {
						acc = ((acc + v.getInt16(q + i * 2, true)) << 16) >> 16;
						data[i] = acc / 32768;
					} else {
						acc = ((acc + ((b[q + i] << 24) >> 24)) << 24) >> 24;
						data[i] = acc / 128;
					}
				}
				q += h.len;
				const lt = h.type & 3;
				const ls = wide ? h.loopStart >> 1 : h.loopStart;
				const ll = wide ? h.loopLen >> 1 : h.loopLen;
				const s: Sample = {
					name: h.name,
					data,
					loopType: lt === 3 || ll === 0 ? 0 : (lt as 1 | 2),
					loopStart: Math.min(ls, frames),
					loopEnd: Math.min(ls + ll, frames),
					volume: h.volume,
					finetune: h.finetune,
					relativeNote: h.rel,
					baseFreq: 8363,
					pan: h.pan,
				};
				inst.samples.push(s);
			}
			p = q;
		} else p += size;
		instruments.push(inst);
	}
	const linear = (flags & 1) !== 0;
	return {
		format: 'xm',
		title,
		channels,
		patterns,
		order,
		restartPosition: restart,
		initialSpeed: speed,
		initialTempo: tempo,
		amiga: !linear,
		linear,
		instruments,
		defaultPan: new Array<number>(channels).fill(128),
		channelVolume: new Array<number>(channels).fill(64),
		globalVolume: 64,
		comment:
			instruments
				.map((i) => i.name)
				.filter(Boolean)
				.join('\n') || undefined,
	};
}

export function loadXm(bytes: Uint8Array, options: ModuleOptions = {}): ModulePlayer {
	return new ModulePlayer(parseXm(bytes), options);
}

import { translateEffect, translateVolume } from './it.ts';
import { ModulePlayer, type ModuleOptions } from './player.ts';
import type { Cell, Instrument, Pattern, Sample, TrackerSong } from './types.ts';

export function isS3m(b: Uint8Array): boolean {
	return b.length > 0x60 && String.fromCharCode(...b.subarray(0x2c, 0x30)) === 'SCRM';
}

const text = (b: Uint8Array, o: number, n: number): string =>
	String.fromCharCode(...b.subarray(o, o + n))
		.replace(/\0.*$/, '')
		.trimEnd();

/**
 * Parse a ScreamTracker 3 module (`.s3m`): up to 32 PCM channels, 8 / 16 bit samples with a C-4 speed, 64 row
 * patterns of packed cells, the effect set of ScreamTracker (A-V, translated to the engine's effect numbering like the
 * IT parser, since IT inherited the lettering). AdLib instruments (type 2+) are kept as empty samples.
 */
export function parseS3m(b: Uint8Array): TrackerSong {
	if (!isS3m(b)) throw new Error('not an S3M file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const ordNum = v.getUint16(0x20, true);
	const insNum = v.getUint16(0x22, true);
	const patNum = v.getUint16(0x24, true);
	const ffi = v.getUint16(0x2a, true); // 1 signed samples, 2 unsigned
	const globalVol = b[0x30];
	const speed = b[0x31] || 6;
	const tempo = b[0x32] >= 33 ? b[0x32] : 125;
	const stereo = (b[0x33] & 0x80) !== 0;
	const chanSettings = Array.from(b.subarray(0x40, 0x60));
	const used = chanSettings.map((c, i) => (c < 16 ? i : -1)).filter((i) => i >= 0);
	const orders = Array.from(b.subarray(0x60, 0x60 + ordNum)).filter((o) => o < 254);
	let q = 0x60 + ordNum;
	const insPtr = Array.from({ length: insNum }, (_, i) => v.getUint16(q + i * 2, true) * 16);
	q += insNum * 2;
	const patPtr = Array.from({ length: patNum }, (_, i) => v.getUint16(q + i * 2, true) * 16);

	const samples: Sample[] = insPtr.map((o) => {
		const empty: Sample = {
			name: '',
			data: new Float32Array(0),
			loopType: 0,
			loopStart: 0,
			loopEnd: 0,
			volume: 0,
			finetune: 0,
			relativeNote: 0,
			baseFreq: 8363,
			pan: -1,
		};
		if (!o || o + 0x50 > b.length) return empty;
		const type = b[o];
		const name = text(b, o + 0x30, 28);
		if (type !== 1) return { ...empty, name };
		const memseg = (b[o + 13] << 16) | (b[o + 15] << 8) | b[o + 14];
		const length = v.getUint32(o + 0x10, true);
		const loopStart = v.getUint32(o + 0x14, true);
		const loopEnd = v.getUint32(o + 0x18, true);
		const vol = b[o + 0x1c];
		const flags = b[o + 0x1f];
		const c2spd = v.getUint32(o + 0x20, true) || 8363;
		const wide = (flags & 4) !== 0;
		const channelsInSample = flags & 2 ? 2 : 1;
		const at = memseg * 16;
		const frames = Math.min(length, Math.floor((b.length - at) / (wide ? 2 : 1) / channelsInSample));
		const data = new Float32Array(Math.max(0, frames));
		for (let i = 0; i < data.length; i++) {
			if (wide) {
				const raw = v.getUint16(at + i * 2, true);
				data[i] = (ffi === 1 ? (raw << 16) >> 16 : raw - 32768) / 32768;
			} else {
				const raw = b[at + i];
				data[i] = (ffi === 1 ? (raw << 24) >> 24 : raw - 128) / 128;
			}
		}
		const looped = (flags & 1) !== 0 && loopEnd > loopStart;
		return {
			name,
			data,
			loopType: looped ? 1 : 0,
			loopStart: Math.min(loopStart, data.length),
			loopEnd: Math.min(loopEnd, data.length),
			volume: Math.min(64, vol),
			finetune: 0,
			relativeNote: 0,
			baseFreq: c2spd,
			pan: -1,
		};
	});
	const instruments: Instrument[] = samples.map((s) => ({ name: s.name, samples: [s], fadeout: 0 }));

	const channels = (used.length ? Math.max(...used) : 0) + 1;
	const patterns: Pattern[] = patPtr.map((o) => {
		const cells: Cell[][] = Array.from({ length: 64 }, () =>
			Array.from({ length: channels }, () => ({ note: 0, instrument: 0, volume: 0, effect: 0, param: 0 })),
		);
		if (!o || o + 2 > b.length) return { rows: 64, cells };
		const len = v.getUint16(o, true);
		let p = o + 2;
		const end = Math.min(b.length, o + len);
		let row = 0;
		while (row < 64 && p < end) {
			const what = b[p++];
			if (what === 0) {
				row++;
				continue;
			}
			const ch = what & 31;
			const cell: Cell = { note: 0, instrument: 0, volume: 0, effect: 0, param: 0 };
			if (what & 32) {
				const n = b[p++];
				cell.instrument = b[p++];
				// 255: no note, 254: note cut; otherwise octave in the high nibble: C-4 plays the sample at its C-4 speed
				if (n === 254) cell.note = 254;
				else if (n !== 255) cell.note = (n >> 4) * 12 + (n & 15) + 1 + 12;
			}
			if (what & 64) cell.volume = translateVolume(b[p++]);
			if (what & 128) {
				const [e, pr] = translateEffect(b[p], b[p + 1]);
				cell.effect = e;
				cell.param = pr;
				p += 2;
			}
			if (ch < channels) cells[row][ch] = cell;
		}
		return { rows: 64, cells };
	});

	const defaultPan = Array.from({ length: channels }, (_, i) => {
		if (!stereo) return 128;
		const c = chanSettings[i];
		return c < 8 ? 48 : 208; // left channels 0-7, right channels 8-15
	});
	return {
		format: 's3m',
		title: text(b, 0, 28),
		channels,
		patterns,
		order: orders,
		restartPosition: 0,
		initialSpeed: speed,
		initialTempo: tempo,
		amiga: false,
		linear: true,
		instruments,
		defaultPan,
		channelVolume: new Array<number>(channels).fill(64),
		globalVolume: Math.min(64, globalVol),
		comment:
			instruments
				.map((i) => i.name)
				.filter(Boolean)
				.join('\n') || undefined,
	};
}

export function loadS3m(bytes: Uint8Array, options: ModuleOptions = {}): ModulePlayer {
	return new ModulePlayer(parseS3m(bytes), options);
}

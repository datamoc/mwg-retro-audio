import { ModulePlayer, type ModuleOptions } from './player.ts';
import type { Cell, Instrument, Pattern, Sample, TrackerSong } from './types.ts';

const SIGNATURES: Record<string, number> = {
	'M.K.': 4,
	'M!K!': 4,
	FLT4: 4,
	FLT8: 8,
	'4CHN': 4,
	'6CHN': 6,
	'8CHN': 8,
	OCTA: 8,
	OKTA: 8,
	CD81: 8,
};

function channelsOf(sig: string): number {
	if (sig in SIGNATURES) return SIGNATURES[sig];
	let m = /^(\d)CHN$/.exec(sig);
	if (m) return Number(m[1]);
	m = /^(\d\d)CH$/.exec(sig);
	if (m) return Number(m[1]);
	m = /^TDZ(\d)$/.exec(sig);
	return m ? Number(m[1]) : 0;
}

export function isMod(b: Uint8Array): boolean {
	return b.length >= 1084 && channelsOf(String.fromCharCode(...b.subarray(1080, 1084))) > 0;
}

/** Parse a ProTracker / NoiseTracker / FastTracker style `.mod` with 31 samples */
export function parseMod(b: Uint8Array): TrackerSong {
	if (!isMod(b)) throw new Error('not a MOD file (only the 31 sample "M.K." family is supported)');
	const channels = channelsOf(String.fromCharCode(...b.subarray(1080, 1084)));
	const title = String.fromCharCode(...b.subarray(0, 20)).replace(/\0.*$/, '');
	const headers: {
		name: string;
		len: number;
		finetune: number;
		volume: number;
		loopStart: number;
		loopLen: number;
	}[] = [];
	for (let i = 0; i < 31; i++) {
		const o = 20 + i * 30;
		const ft = b[o + 24] & 15;
		headers.push({
			name: String.fromCharCode(...b.subarray(o, o + 22)).replace(/\0.*$/, ''),
			len: ((b[o + 22] << 8) | b[o + 23]) * 2,
			finetune: ft < 8 ? ft : ft - 16,
			volume: Math.min(64, b[o + 25]),
			loopStart: ((b[o + 26] << 8) | b[o + 27]) * 2,
			loopLen: ((b[o + 28] << 8) | b[o + 29]) * 2,
		});
	}
	const songLen = Math.min(128, b[950]);
	const restart = b[951] < songLen ? b[951] : 0;
	const orders = Array.from(b.subarray(952, 952 + 128));
	const order = orders.slice(0, Math.max(1, songLen));
	const nPatterns = Math.max(...orders) + 1;
	const patterns: Pattern[] = [];
	let p = 1084;
	for (let n = 0; n < nPatterns; n++) {
		const cells: Cell[][] = [];
		for (let r = 0; r < 64; r++) {
			const row: Cell[] = [];
			for (let c = 0; c < channels; c++, p += 4) {
				const b0 = b[p] ?? 0;
				const b1 = b[p + 1] ?? 0;
				const b2 = b[p + 2] ?? 0;
				const b3 = b[p + 3] ?? 0;
				const period = ((b0 & 15) << 8) | b1;
				row.push({
					note: period ? 1 : 0,
					instrument: (b0 & 0xf0) | (b2 >> 4),
					volume: 0,
					effect: b2 & 15,
					param: b3,
					period,
				});
			}
			cells.push(row);
		}
		patterns.push({ rows: 64, cells });
	}
	const instruments: Instrument[] = headers.map((h) => {
		const raw = b.subarray(p, p + h.len);
		p += h.len;
		const data = new Float32Array(raw.length);
		for (let i = 0; i < raw.length; i++) data[i] = ((raw[i] << 24) >> 24) / 128;
		const looped = h.loopLen > 2;
		const sample: Sample = {
			name: h.name,
			data,
			loopType: looped ? 1 : 0,
			loopStart: looped ? Math.min(h.loopStart, data.length) : 0,
			loopEnd: looped ? Math.min(h.loopStart + h.loopLen, data.length) : data.length,
			volume: h.volume,
			finetune: h.finetune,
			relativeNote: 0,
			baseFreq: 8363,
			pan: -1,
		};
		return { name: h.name, samples: [sample], fadeout: 0 };
	});
	// Amiga hard panning: channels 0 and 3 left, 1 and 2 right (LRRL)
	const defaultPan = Array.from({ length: channels }, (_, i) => ((i & 3) === 0 || (i & 3) === 3 ? 0 : 255));
	return {
		format: 'mod',
		title,
		channels,
		patterns,
		order,
		restartPosition: restart,
		initialSpeed: 6,
		initialTempo: 125,
		amiga: true,
		linear: false,
		instruments,
		defaultPan,
		channelVolume: new Array<number>(channels).fill(64),
		globalVolume: 64,
		comment:
			instruments
				.map((i) => i.name)
				.filter(Boolean)
				.join('\n') || undefined,
	};
}

export function loadMod(bytes: Uint8Array, options: ModuleOptions = {}): ModulePlayer {
	return new ModulePlayer(parseMod(bytes), options);
}

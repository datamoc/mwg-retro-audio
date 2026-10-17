import { SincResampler } from '../driver/Resampler.ts';
import type { Chip } from '../chips/Chip.ts';
import type { PlayerInfo, RetroPlayer } from '../players/Player.ts';
import { Region } from '../region.ts';
import type { LoadOptions } from './mwa.ts';

/** A decoded sample: float channels in -1..1 at the rate of the original recording */
export interface PcmClip {
	rate: number;
	channels: Float32Array[];
	title?: string;
	/** loop region in frames, when the format has one */
	loop?: { start: number; end: number };
}

export function isWav(b: Uint8Array): boolean {
	return (
		b.length > 12 &&
		String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' &&
		String.fromCharCode(...b.subarray(8, 12)) === 'WAVE'
	);
}

export function isVoc(b: Uint8Array): boolean {
	return b.length > 26 && String.fromCharCode(...b.subarray(0, 19)) === 'Creative Voice File';
}

/** Parse a PCM `.wav` (8, 16, 24, 32 bit integer or 32 bit float; mono or stereo or more) */
export function parseWav(b: Uint8Array): PcmClip {
	if (!isWav(b)) throw new Error('not a WAV file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let p = 12;
	let fmt: { tag: number; ch: number; rate: number; bits: number } | null = null;
	let data: Uint8Array | null = null;
	while (p + 8 <= b.length) {
		const id = String.fromCharCode(...b.subarray(p, p + 4));
		const size = v.getUint32(p + 4, true);
		const body = b.subarray(p + 8, Math.min(b.length, p + 8 + size));
		if (id === 'fmt ') {
			let tag = v.getUint16(p + 8, true);
			if (tag === 0xfffe && size >= 26) tag = v.getUint16(p + 8 + 24, true); // WAVE_FORMAT_EXTENSIBLE
			fmt = {
				tag,
				ch: v.getUint16(p + 10, true),
				rate: v.getUint32(p + 12, true),
				bits: v.getUint16(p + 22, true),
			};
		} else if (id === 'data') data = body;
		p += 8 + size + (size & 1);
	}
	if (!fmt || !data) throw new Error('WAV: missing fmt or data chunk');
	if (fmt.tag !== 1 && fmt.tag !== 3) throw new Error(`WAV: unsupported format ${fmt.tag} (only PCM and float)`);
	const bytes = fmt.bits / 8;
	const frames = Math.floor(data.length / (bytes * fmt.ch));
	const channels = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
	for (let i = 0; i < frames; i++) {
		for (let c = 0; c < fmt.ch; c++) {
			const o = (i * fmt.ch + c) * bytes;
			let x: number;
			if (fmt.tag === 3) x = fmt.bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
			else if (fmt.bits === 8) x = (data[o] - 128) / 128;
			else if (fmt.bits === 16) x = dv.getInt16(o, true) / 32768;
			else if (fmt.bits === 24) x = (((data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8) >> 8) / 8388608;
			else x = dv.getInt32(o, true) / 2147483648;
			channels[c][i] = x;
		}
	}
	return { rate: fmt.rate, channels };
}

/** ADPCM blocks (SB 4-bit, 2.6-bit, 2-bit) are skipped: said in the error when nothing else is found */
const CL_SETUP = {
	4: { maxIndex: 3, sign: 8, steps: [0x100, 0x200, 0x400, 0x800], changes: [-1, 0, 0, 0, 0, 1, 1, 1] },
	3: { maxIndex: 4, sign: 4, steps: [0x100, 0x200, 0x400, 0x800, 0xa00], changes: [-1, 0, 0, 1] },
	2: { maxIndex: 5, sign: 2, steps: [0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000], changes: [-1, 1] },
} as const;

/**
 * Decode the Creative Labs ADPCM of Sound Blaster `.voc` files (codec 1: 4 bit, 2: 2.6 bit, 3: 2 bit): the first byte
 * of the block is the 8 bit reference sample, every following byte carries 2, 3 (3 + 3 + 2 bits) or 4 codes, high
 * bits first; each code adds a signed step to the previous output and moves the step index. Output is -1..1.
 */
export function decodeCreativeAdpcm(data: Uint8Array, bits: 4 | 3 | 2): Float32Array {
	const setup = CL_SETUP[bits];
	const out: number[] = [];
	let last = (data[0] - 128) << 8;
	out.push(last / 32768);
	let index = 0;
	const decode = (code: number): void => {
		let v = ((code & (setup.sign - 1)) << 1) | 1;
		v = ((setup.steps[index] * v) >> 1) & ~255;
		if (code & setup.sign) v = -v;
		last = Math.max(-32768, Math.min(32767, last + v));
		index = Math.max(0, Math.min(setup.maxIndex, index + setup.changes[code & (setup.sign - 1)]));
		out.push(last / 32768);
	};
	for (let i = 1; i < data.length; i++) {
		const u = data[i];
		if (bits === 4) {
			decode(u >> 4);
			decode(u);
		} else if (bits === 3) {
			decode(u >> 5);
			decode(u >> 2);
			decode(u << 1);
		} else {
			decode(u >> 6);
			decode(u >> 4);
			decode(u >> 2);
			decode(u);
		}
	}
	return Float32Array.from(out);
}

const ADPCM_STEPS_NOTE = 'ADPCM blocks are not decoded';

/**
 * Parse a Creative Voice File (`.voc`, Sound Blaster): sound data blocks (8 bit unsigned PCM, 16 bit signed in
 * the version 2 blocks), silence blocks, repeat loops and the extended block for stereo. ADPCM blocks are skipped
 * (`ADPCM_STEPS_NOTE`). Blocks of different rates are resampled to the rate of the first block.
 */
export function parseVoc(b: Uint8Array): PcmClip {
	if (!isVoc(b)) throw new Error('not a VOC file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	let p = v.getUint16(20, true);
	let rate = 0;
	let extRate = 0;
	let extStereo = false;
	const loops: { start: number; count: number }[] = [];
	let guard = 0;
	const out: { rate: number; data: Float32Array[]; silenceSec?: number }[] = [];
	while (p < b.length && guard++ < 100000) {
		const type = b[p];
		if (type === 0) break;
		const size = b[p + 1] | (b[p + 2] << 8) | (b[p + 3] << 16);
		const body = b.subarray(p + 4, p + 4 + size);
		if (type === 1) {
			const tc = body[0];
			const codec = body[1];
			const r = extRate || Math.round(1_000_000 / (256 - tc));
			if (codec >= 1 && codec <= 3) {
				const pcm = decodeCreativeAdpcm(body.subarray(2), (5 - codec) as 4 | 3 | 2);
				out.push({ rate: r, data: [pcm] });
				if (!rate) rate = r;
			} else if (codec === 0) {
				const pcm = new Float32Array(body.length - 2);
				for (let i = 0; i < pcm.length; i++) pcm[i] = (body[2 + i] - 128) / 128;
				out.push({
					rate: r,
					data: extStereo ? [pcm.filter((_, i) => i % 2 === 0), pcm.filter((_, i) => i % 2 === 1)] : [pcm],
				});
				if (!rate) rate = r;
			}
			extRate = 0;
			extStereo = false;
		} else if (type === 2) {
			// continuation of the previous sound block: same rate
			const last = out[out.length - 1];
			if (last && last.data.length === 1) {
				const pcm = new Float32Array(body.length);
				for (let i = 0; i < pcm.length; i++) pcm[i] = (body[i] - 128) / 128;
				const merged = new Float32Array(last.data[0].length + pcm.length);
				merged.set(last.data[0]);
				merged.set(pcm, last.data[0].length);
				last.data[0] = merged;
			}
		} else if (type === 3) {
			const len = (body[0] | (body[1] << 8)) + 1;
			const tc = body[2];
			const r = Math.round(1_000_000 / (256 - tc));
			out.push({ rate: r, data: [new Float32Array(0)], silenceSec: len / r });
		} else if (type === 6) {
			loops.push({ start: out.length, count: body[0] | (body[1] << 8) });
		} else if (type === 7 && loops.length) {
			const l = loops[loops.length - 1];
			const blocks = out.slice(l.start);
			const reps = l.count === 0xffff ? 1 : l.count; // an endless loop is played once
			for (let k = 0; k < reps; k++) for (const bl of blocks) out.push(bl);
		} else if (type === 8) {
			const rdiv = body[0] | (body[1] << 8);
			extRate = Math.round(256_000_000 / ((body[3] ? 2 : 1) * (65536 - rdiv)));
			extStereo = body[3] === 1;
			if (extStereo) extRate = Math.round(extRate / 2);
		} else if (type === 9) {
			const r = v.getUint32(p + 4, true);
			const bits = body[4];
			const ch = body[5];
			const codec = v.getUint16(p + 4 + 6, true);
			const raw = body.subarray(12);
			if (codec === 0 || codec === 4) {
				const bytes = bits / 8;
				const frames = Math.floor(raw.length / (bytes * ch));
				const dat = Array.from({ length: ch }, () => new Float32Array(frames));
				const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
				for (let i = 0; i < frames; i++)
					for (let c = 0; c < ch; c++) {
						const o = (i * ch + c) * bytes;
						dat[c][i] = bits === 8 ? (raw[o] - 128) / 128 : dv.getInt16(o, true) / 32768;
					}
				out.push({ rate: r, data: dat });
				if (!rate) rate = r;
			}
		}
		p += 4 + size;
	}
	if (!rate) throw new Error(`VOC: no PCM sound data (${ADPCM_STEPS_NOTE})`);
	const parts: Float32Array[][] = [];
	let channels = 1;
	for (const o of out) channels = Math.max(channels, o.data.length);
	for (const o of out) {
		const dur = o.silenceSec ? Math.round(o.silenceSec * rate) : 0;
		if (dur) {
			parts.push(Array.from({ length: channels }, () => new Float32Array(dur)));
			continue;
		}
		const res = o.rate === rate ? o.data : o.data.map((c) => resampleArray(c, o.rate, rate));
		parts.push(Array.from({ length: channels }, (_, c) => res[Math.min(c, res.length - 1)]));
	}
	const total = parts.reduce((n, pt) => n + pt[0].length, 0);
	const chans = Array.from({ length: channels }, () => new Float32Array(total));
	let at = 0;
	for (const pt of parts) {
		for (let c = 0; c < channels; c++) chans[c].set(pt[c], at);
		at += pt[0].length;
	}
	return { rate, channels: chans };
}

/** band-limited resample of one channel */
export function resampleArray(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
	if (srcRate === dstRate || src.length === 0) return src.slice();
	let pos = 0;
	const rs = new SincResampler(srcRate, dstRate, (l, r, n) => {
		for (let i = 0; i < n; i++) {
			l[i] = r[i] = pos < src.length ? src[pos] : 0;
			pos++;
		}
	});
	const frames = Math.ceil((src.length * dstRate) / srcRate);
	const l = new Float32Array(frames);
	const r = new Float32Array(frames);
	rs.render(l, r, 0, frames);
	return l;
}

/** Plays a decoded sample (or any PCM clip) through the engine like any other player */
export class PcmPlayer implements RetroPlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[] = [];
	readonly sampleRate: number;
	private readonly left: Float32Array;
	private readonly right: Float32Array;
	private pos = 0;
	private readonly loop: boolean;
	private readonly loopStart: number;
	private readonly loopEnd: number;
	private muted = false;

	constructor(clip: PcmClip, options: LoadOptions = {}, format = 'pcm') {
		this.sampleRate = options.sampleRate ?? 44100;
		this.loop = options.loop ?? false;
		const l = resampleArray(clip.channels[0], clip.rate, this.sampleRate);
		const r = clip.channels.length > 1 ? resampleArray(clip.channels[1], clip.rate, this.sampleRate) : l;
		this.left = l;
		this.right = r;
		const k = this.sampleRate / clip.rate;
		this.loopStart = clip.loop ? Math.round(clip.loop.start * k) : 0;
		this.loopEnd = clip.loop ? Math.min(l.length, Math.round(clip.loop.end * k)) : l.length;
		this.info = {
			format,
			title: clip.title,
			chips: [],
			region: Region.NTSC,
			frameRate: 60,
			durationSeconds: l.length / this.sampleRate,
			loopStartSeconds: clip.loop ? this.loopStart / this.sampleRate : undefined,
		};
	}

	get finished(): boolean {
		return !this.loop && this.pos >= this.left.length;
	}

	reset(): void {
		this.pos = 0;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): number {
		let done = 0;
		while (done < count) {
			const end = this.loop ? this.loopEnd : this.left.length;
			if (this.pos >= end) {
				if (this.loop && end > this.loopStart) this.pos = this.loopStart;
				else break;
			}
			const n = Math.min(count - done, end - this.pos);
			if (!this.muted) {
				for (let i = 0; i < n; i++) {
					left[start + done + i] += this.left[this.pos + i];
					right[start + done + i] += this.right[this.pos + i];
				}
			}
			this.pos += n;
			done += n;
		}
		return done;
	}

	setMuted(_chipIndex: number, _channel: number, muted: boolean): void {
		this.muted = muted;
	}
}

export function loadWav(bytes: Uint8Array, options: LoadOptions = {}): PcmPlayer {
	return new PcmPlayer(parseWav(bytes), options, 'wav');
}

export function loadVoc(bytes: Uint8Array, options: LoadOptions = {}): PcmPlayer {
	return new PcmPlayer(parseVoc(bytes), options, 'voc');
}

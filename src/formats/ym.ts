import type { Chip } from '../chips/Chip.ts';
import { createChip } from '../chips/index.ts';
import { FramePlayer, type PlayerInfo } from '../players/Player.ts';
import { regionFromFrameRate } from '../region.ts';
import { isLha, unlha } from './lha.ts';
import type { LoadOptions } from './mwa.ts';

/** Atari ST MFP 68901 timer clock, used to time digidrums, SID voices and sync-buzzer */
const MFP_CLOCK = 2_457_600;
const MFP_PREDIV = [0, 4, 10, 16, 50, 64, 100, 200];

export interface YmSong {
	/** 'YM2!', 'YM3!', 'YM3b', 'YM4!', 'YM5!', 'YM6!' */
	version: string;
	title: string;
	author: string;
	comment: string;
	clock: number;
	frameRate: number;
	frames: number;
	loopFrame: number;
	/** registers per frame: 14 (YM2/3) or 16 (YM5/6, R14 and R15 drive the effects) */
	regsPerFrame: number;
	/** register-major data: `data[reg * frames + frame]` */
	data: Uint8Array;
	/** digidrum samples (8 bit unsigned) */
	drums: Uint8Array[];
}

const be32 = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];

function cstring(b: Uint8Array, pos: { o: number }): string {
	let s = '';
	while (pos.o < b.length && b[pos.o] !== 0) s += String.fromCharCode(b[pos.o++]);
	pos.o++;
	return s;
}

/** true for a YM file, packed with LHA or not */
export function isYm(bytes: Uint8Array): boolean {
	if (isLha(bytes)) return true;
	return /^YM[2-6][!b]/.test(String.fromCharCode(...bytes.subarray(0, 4)));
}

/** Parse the YM2! / YM3! / YM3b! / YM4! / YM5! / YM6! formats (LHA packed files are unpacked first) */
export function parseYm(input: Uint8Array): YmSong {
	const b = isLha(input) ? unlha(input) : input;
	const version = String.fromCharCode(b[0], b[1], b[2], b[3]);
	if (!/^YM[2-6][!b]$/.test(version)) throw new Error(`not a YM file (${JSON.stringify(version)})`);
	if (version === 'YM2!' || version === 'YM3!' || version === 'YM3b') {
		const tail = version === 'YM3b' ? 4 : 0;
		const frames = Math.floor((b.length - 4 - tail) / 14);
		const data = b.slice(4, 4 + frames * 14); // register-major already
		const loopFrame = version === 'YM3b' ? be32(b, b.length - 4) : 0;
		return {
			version,
			title: '',
			author: '',
			comment: '',
			clock: 2_000_000,
			frameRate: 50,
			frames,
			loopFrame,
			regsPerFrame: 14,
			data,
			drums: [],
		};
	}
	if (version === 'YM4!') throw new Error('YM4! (with MadMax digi effects) is not supported');
	// YM5! / YM6!
	if (String.fromCharCode(...b.subarray(4, 12)) !== 'LeOnArD!') throw new Error('YM5/6: missing LeOnArD! signature');
	const frames = be32(b, 12);
	const attrs = be32(b, 16);
	const nDrums = be16(b, 20);
	const clock = be32(b, 22);
	const frameRate = be16(b, 26);
	const loopFrame = be32(b, 28);
	const extra = be16(b, 32);
	const pos = { o: 34 + extra };
	const drums: Uint8Array[] = [];
	for (let i = 0; i < nDrums; i++) {
		const size = be32(b, pos.o);
		pos.o += 4;
		let d = b.slice(pos.o, pos.o + size);
		pos.o += size;
		if (attrs & 4) d = d.map((v) => (v & 15) * 17); // 4 bit samples stored one per byte
		drums.push(d);
	}
	const title = cstring(b, pos);
	const author = cstring(b, pos);
	const comment = cstring(b, pos);
	const raw = b.subarray(pos.o, pos.o + frames * 16);
	if (raw.length < frames * 16) throw new Error('YM5/6: truncated register data');
	let data: Uint8Array;
	if (attrs & 1) data = raw.slice();
	else {
		// frame-major -> register-major
		data = new Uint8Array(frames * 16);
		for (let f = 0; f < frames; f++) for (let r = 0; r < 16; r++) data[r * frames + f] = raw[f * 16 + r];
	}
	return {
		version,
		title,
		author,
		comment,
		clock,
		frameRate: frameRate || 50,
		frames,
		loopFrame,
		regsPerFrame: 16,
		data,
		drums,
	};
}

interface VoiceFx {
	/** absolute sample position of the next timer tick, continuous across frames */
	next: number;
	/** parity of the toggle (SID voice) / index in the sine table */
	phase: number;
}

const SINUS = [0, 0.1465, 0.5, 0.8536, 1, 0.8536, 0.5, 0.1465]; // 8 steps of (1 + sin) / 2 at 45 degree steps

/**
 * Plays a YM register dump on a YM2149. Every frame the 14 or 16 registers are written; for YM5!/YM6! the effects
 * the Atari ST programmed on its MFP timers are reproduced as timed register writes inside the frame:
 * SID voice (volume toggled at the timer rate), digidrums (8 bit sample played through the volume register at the
 * timer rate), sinus-SID and sync-buzzer (envelope restarted at the timer rate).
 */
export class YmPlayer extends FramePlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[];
	private readonly ym: Chip;
	private readonly loop: boolean;
	private frame = 0;
	private absSamples = 0;
	private readonly fx: (VoiceFx | null)[] = [null, null, null];
	private readonly drumLeft = [0, 0, 0];

	constructor(
		readonly song: YmSong,
		options: LoadOptions = {},
	) {
		super(options.sampleRate ?? 44100);
		const factory = options.chipFactory ?? createChip;
		this.ym = factory('ym2149', { sampleRate: this.sampleRate, clock: song.clock });
		this.chips = [this.ym];
		this.loop = options.loop ?? false;
		this.info = {
			format: 'ym',
			title: song.title || undefined,
			author: song.author || undefined,
			comment: song.comment || undefined,
			chips: ['ym2149'],
			region: regionFromFrameRate(song.frameRate),
			frameRate: song.frameRate,
			durationSeconds: song.frames / song.frameRate,
			loopStartSeconds: song.loopFrame > 0 ? song.loopFrame / song.frameRate : undefined,
		};
	}

	protected currentFrameRate(): number {
		return this.song.frameRate;
	}

	protected restart(): void {
		this.frame = 0;
		this.absSamples = 0;
		this.fx.fill(null);
		this.drumLeft.fill(0);
	}

	private reg(r: number, f = this.frame): number {
		return this.song.data[r * this.song.frames + f];
	}

	protected beginFrame(): boolean {
		const s = this.song;
		if (this.frame >= s.frames) {
			if (!this.loop) return false;
			this.frame = Math.min(s.loopFrame, s.frames - 1);
		}
		const f = this.frame++;
		const frameLen = this.sampleRate / s.frameRate;
		for (let r = 0; r < 14; r++) {
			const v = this.reg(r, f);
			if (r === 13 && v === 0xff) continue; // 0xFF = leave the envelope running
			this.ym.write(r, v);
		}
		if (s.regsPerFrame === 16) {
			this.effect(f, 1, 6, 14, frameLen);
			this.effect(f, 3, 8, 15, frameLen);
		}
		this.absSamples += frameLen;
		return true;
	}

	private effect(f: number, codeReg: number, predivReg: number, countReg: number, frameLen: number): void {
		const code = this.reg(codeReg, f) & 0xf0;
		const voiceSel = (code & 0x30) >> 4;
		if (!voiceSel) return;
		const voice = voiceSel - 1;
		const prediv = MFP_PREDIV[(this.reg(predivReg, f) >> 5) & 7];
		const count = this.reg(countReg, f);
		const divisor = prediv * count;
		if (!divisor) return;
		const hz = MFP_CLOCK / divisor;
		const period = this.sampleRate / hz; // samples between two timer interrupts
		const kind = code & 0xc0;
		const volReg = 8 + voice;
		const baseVol = this.reg(volReg, f) & 15;
		let st = this.fx[voice];
		if (!st) st = this.fx[voice] = { next: 0, phase: 0 };
		if (kind === 0x40) {
			// digidrum: the byte at the volume register's low 5 bits selects the sample
			const n = this.reg(volReg, f) & 31;
			const sample = this.song.drums[n];
			if (!sample || !sample.length) return;
			if (this.drumLeft[voice] > 0) return; // still playing the previous drum
			const mixer = this.reg(7, f) | (1 << voice) | (8 << voice); // tone and noise off for the voice
			this.ym.write(7, mixer);
			let t = 0;
			for (let i = 0; i < sample.length; i++, t += period) {
				const v = sample[i] >> 4;
				this.at(t, () => this.ym.write(volReg, v));
			}
			const end = t;
			this.drumLeft[voice] = Math.ceil(end / frameLen);
			this.at(end, () => {
				this.ym.write(7, this.reg(7, Math.max(0, this.frame - 1)));
				this.ym.write(volReg, baseVol);
			});
			return;
		}
		if (this.drumLeft[voice] > 0) this.drumLeft[voice]--;
		// continuous timer phase: first tick position inside this frame
		let t = st.next - this.absSamples;
		if (t < 0 || t > period) t = 0;
		if (kind === 0x00) {
			// SID voice: the volume flips between its value and 0 at every timer tick
			for (let k = t; k < frameLen; k += period) {
				st.phase ^= 1;
				const v = st.phase ? baseVol : 0;
				this.at(k, () => this.ym.write(volReg, v));
				st.next = this.absSamples + k + period;
			}
		} else if (kind === 0x80) {
			for (let k = t; k < frameLen; k += period) {
				st.phase = (st.phase + 1) & 7;
				const v = Math.round(baseVol * SINUS[st.phase]);
				this.at(k, () => this.ym.write(volReg, v));
				st.next = this.absSamples + k + period;
			}
		} else {
			// sync buzzer: the envelope restarts at the timer rate
			const shape = this.reg(13, f);
			this.ym.write(volReg, 0x10);
			for (let k = t; k < frameLen; k += period) {
				if (shape !== 0xff) this.at(k, () => this.ym.write(13, shape & 15));
				st.next = this.absSamples + k + period;
			}
		}
	}
}

/** Load a YM file into a player */
export function loadYm(bytes: Uint8Array, options: LoadOptions = {}): YmPlayer {
	return new YmPlayer(parseYm(bytes), options);
}

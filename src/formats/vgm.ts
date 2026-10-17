import type { Chip } from '../chips/Chip.ts';
import { createChip } from '../chips/index.ts';
import type { PlayerInfo, RetroPlayer } from '../players/Player.ts';
import { Region, regionFromFrameRate } from '../region.ts';
import { gunzip, isGzip } from './inflate.ts';
import type { LoadOptions } from './mwa.ts';

/** VGM time base: all waits are in samples at 44100 Hz */
const VGM_RATE = 44100;

export interface VgmTags {
	title: string;
	game: string;
	system: string;
	author: string;
	date: string;
	notes: string;
}

export interface VgmFile {
	version: number;
	data: Uint8Array;
	/** offset of the first command */
	dataStart: number;
	totalSamples: number;
	loopSamples: number;
	/** absolute offset of the loop target, or -1 */
	loopOffset: number;
	rate: number;
	tags: VgmTags;
	/** chip clocks found in the header (0 = absent) */
	clocks: Record<string, number>;
	snFeedback: number;
	ayType: number;
}

export function isVgm(bytes: Uint8Array): boolean {
	if (isGzip(bytes)) return true;
	return bytes.length > 0x40 && bytes[0] === 0x56 && bytes[1] === 0x67 && bytes[2] === 0x6d && bytes[3] === 0x20;
}

function utf16(b: Uint8Array, o: number): [string, number] {
	let s = '';
	while (o + 1 < b.length) {
		const c = b[o] | (b[o + 1] << 8);
		o += 2;
		if (c === 0) break;
		s += String.fromCharCode(c);
	}
	return [s, o];
}

/** Parse a `.vgm` or `.vgz` (gzip) file */
export function parseVgm(input: Uint8Array): VgmFile {
	const b = isGzip(input) ? gunzip(input) : input;
	if (!(b[0] === 0x56 && b[1] === 0x67 && b[2] === 0x6d && b[3] === 0x20)) throw new Error('not a VGM file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const u32 = (o: number): number => (o + 4 <= b.length ? v.getUint32(o, true) : 0);
	const version = u32(8);
	const dataStart = version >= 0x150 && u32(0x34) ? 0x34 + u32(0x34) : 0x40;
	const loopRel = u32(0x1c);
	const clocks: Record<string, number> = {
		sn76489: u32(0x0c) & 0x3fffffff,
		ym2612: version >= 0x110 ? u32(0x2c) & 0x3fffffff : 0,
		ym2151: version >= 0x110 ? u32(0x30) & 0x3fffffff : 0,
		ym2203: version >= 0x151 ? u32(0x44) & 0x3fffffff : 0,
		ym2608: version >= 0x151 ? u32(0x48) & 0x3fffffff : 0,
		ym3812: version >= 0x151 ? u32(0x50) & 0x3fffffff : 0,
		ymf262: version >= 0x151 ? u32(0x5c) & 0x3fffffff : 0,
		ay8910: version >= 0x151 ? u32(0x74) & 0x3fffffff : 0,
		nes: version >= 0x161 ? u32(0x84) & 0x3fffffff : 0,
	};
	const dual: Record<string, boolean> = {
		sn76489: (u32(0x0c) & 0x40000000) !== 0,
		ay8910: version >= 0x151 && (u32(0x74) & 0x40000000) !== 0,
	};
	for (const [k, d] of Object.entries(dual)) if (d) clocks[`${k}#2`] = clocks[k];
	// other chips that exist in the header but are not emulated: kept so the caller can report them
	const absent: Record<string, number> = {
		ym2413: u32(0x10),
		ym2610: version >= 0x151 ? u32(0x4c) : 0,
		gbDmg: version >= 0x161 ? u32(0x80) : 0,
	};
	for (const [k, c] of Object.entries(absent)) if (c) clocks[`unsupported:${k}`] = c & 0x3fffffff;
	const tags: VgmTags = { title: '', game: '', system: '', author: '', date: '', notes: '' };
	const gd3Rel = u32(0x14);
	if (gd3Rel) {
		let o = 0x14 + gd3Rel;
		if (String.fromCharCode(...b.subarray(o, o + 4)) === 'Gd3 ') {
			o += 12;
			const fields: string[] = [];
			for (let i = 0; i < 11 && o < b.length; i++) {
				const [s, next] = utf16(b, o);
				fields.push(s);
				o = next;
			}
			tags.title = fields[0] ?? '';
			tags.game = fields[2] ?? '';
			tags.system = fields[4] ?? '';
			tags.author = fields[6] ?? '';
			tags.date = fields[8] ?? '';
			tags.notes = fields[10] ?? '';
		}
	}
	return {
		version,
		data: b,
		dataStart,
		totalSamples: u32(0x18),
		loopSamples: u32(0x20),
		loopOffset: loopRel ? 0x1c + loopRel : -1,
		rate: version >= 0x101 ? u32(0x24) : 0,
		tags,
		clocks,
		snFeedback: version >= 0x110 ? v.getUint16(0x28, true) : 0,
		ayType: version >= 0x151 && 0x78 < b.length ? b[0x78] : 0,
	};
}

/**
 * Plays a VGM / VGZ log: SN76489 (also Game Gear stereo), YM2612 (with the PCM data bank and its 0x8n commands),
 * YM2151, YM2203, YM2608 (FM + SSG), YM3812, YMF262, AY-3-8910 family and the NES APU (with DPCM RAM blocks). Chips present in the file but not
 * emulated (YM2413, YM2151, YM2203/2608/2610, Game Boy ...) are silent and listed in `unsupported`; a second copy of
 * the SN76489 or AY-3-8910 is supported through the dual-chip commands.
 */
export class VgmPlayer implements RetroPlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[] = [];
	readonly sampleRate: number;
	/** chips named in the file that this engine does not emulate */
	readonly unsupported: string[] = [];
	private readonly f: VgmFile;
	private readonly loop: boolean;
	private pos: number;
	private wait = 0; // output samples left before the next command
	private waitFraction = 0;
	private ended = false;
	private pcm = new Uint8Array(0);
	private deltaT = new Uint8Array(0);
	private pcmPos = 0;
	private readonly nesMemory = new Uint8Array(0x10000);
	private sn: Chip[] = [];
	private ay: Chip[] = [];
	private ym2612: Chip | null = null;
	private ym2151: Chip | null = null;
	private ym2203: Chip | null = null;
	private ym2608: Chip | null = null;
	private opl2: Chip | null = null;
	private opl3: Chip | null = null;
	private nes: Chip | null = null;
	private loops = 0;

	constructor(file: VgmFile | Uint8Array, options: LoadOptions = {}) {
		this.f = file instanceof Uint8Array ? parseVgm(file) : file;
		this.sampleRate = options.sampleRate ?? 44100;
		this.loop = options.loop ?? false;
		this.pos = this.f.dataStart;
		const make = (id: string, extra: Record<string, unknown>): Chip => {
			const chip = (options.chipFactory ?? createChip)(id, { sampleRate: this.sampleRate, ...extra });
			this.chips.push(chip);
			return chip;
		};
		const c = this.f.clocks;
		for (const k of Object.keys(c)) if (k.startsWith('unsupported:')) this.unsupported.push(k.slice(12));
		if (c.sn76489) {
			const variant = this.f.snFeedback === 0 || this.f.snFeedback === 9 ? 'sega' : 'ti';
			this.sn.push(make('sn76489', { clock: c.sn76489, variant }));
			if (c['sn76489#2']) this.sn.push(make('sn76489', { clock: c['sn76489#2'], variant }));
		}
		if (c.ym2612) this.ym2612 = make('ym2612', { clock: c.ym2612 });
		if (c.ym2151) this.ym2151 = make('ym2151', { clock: c.ym2151 });
		if (c.ym2203) this.ym2203 = make('ym2203', { clock: c.ym2203 });
		if (c.ym2608) this.ym2608 = make('ym2608', { clock: c.ym2608 });
		if (c.ym3812) this.opl2 = make('opl2', { clock: c.ym3812 });
		if (c.ymf262) this.opl3 = make('opl3', { clock: c.ymf262 });
		if (c.ay8910) {
			const model = (this.f.ayType & 0x10) === 0 ? 'ay8910' : 'ym2149';
			const id = model === 'ay8910' ? 'ay8910' : 'ym2149';
			this.ay.push(make(id, { clock: c.ay8910 / 1 }));
			if (c['ay8910#2']) this.ay.push(make(id, { clock: c['ay8910#2'] }));
		}
		if (c.nes) {
			this.nes = make('nes-apu', { clock: c.nes, readMemory: (a: number) => this.nesMemory[a & 0xffff] });
		}
		const frameRate = this.f.rate || 60;
		const t = this.f.tags;
		this.info = {
			format: 'vgm',
			title: t.title || undefined,
			author: t.author || undefined,
			comment: [t.game, t.system, t.notes].filter(Boolean).join(' - ') || undefined,
			chips: this.chips.map((x) => x.id),
			region: regionFromFrameRate(frameRate) as Region,
			frameRate,
			durationSeconds: this.f.totalSamples / VGM_RATE,
			loopStartSeconds:
				this.f.loopOffset >= 0 ? (this.f.totalSamples - this.f.loopSamples) / VGM_RATE : undefined,
		};
	}

	get finished(): boolean {
		return this.ended;
	}

	reset(): void {
		for (const c of this.chips) c.reset();
		this.pos = this.f.dataStart;
		this.wait = 0;
		this.waitFraction = 0;
		this.ended = false;
		this.pcmPos = 0;
		this.loops = 0;
	}

	setMuted(chipIndex: number, channel: number, muted: boolean): void {
		this.chips[chipIndex]?.setMuted(channel, muted);
	}

	private addWait(samples: number): void {
		const exact = (samples * this.sampleRate) / VGM_RATE + this.waitFraction;
		const whole = Math.floor(exact);
		this.waitFraction = exact - whole;
		this.wait += whole;
	}

	/** run commands until one introduces a wait or the stream ends */
	private runCommands(): void {
		const d = this.f.data;
		const len = d.length;
		let guard = 0;
		while (this.wait <= 0 && !this.ended) {
			if (this.pos >= len || ++guard > 1_000_000) {
				this.ended = true;
				return;
			}
			const cmd = d[this.pos++];
			const op = (n: number): number => d[this.pos + n] ?? 0;
			if (cmd >= 0x70 && cmd <= 0x7f) this.addWait((cmd & 15) + 1);
			else if (cmd >= 0x80 && cmd <= 0x8f) {
				if (this.ym2612) this.ym2612.write(0x2a, this.pcm[this.pcmPos++] ?? 0x80);
				this.addWait(cmd & 15);
			} else
				switch (cmd) {
					case 0x4f:
						(this.sn[0] as unknown as { writeStereo?(v: number): void })?.writeStereo?.(op(0));
						this.pos += 1;
						break;
					case 0x50:
						this.sn[0]?.write(0, op(0));
						this.pos += 1;
						break;
					case 0x30:
						this.sn[1]?.write(0, op(0));
						this.pos += 1;
						break;
					case 0x3f:
						(this.sn[1] as unknown as { writeStereo?(v: number): void })?.writeStereo?.(op(0));
						this.pos += 1;
						break;
					case 0x52:
						this.ym2612?.write(op(0), op(1));
						this.pos += 2;
						break;
					case 0x53:
						this.ym2612?.write(0x100 | op(0), op(1));
						this.pos += 2;
						break;
					case 0x54:
						this.ym2151?.write(0x100 | op(0), op(1));
						this.pos += 2;
						break;
					case 0x55:
						this.ym2203?.write(op(0), op(1));
						this.pos += 2;
						break;
					case 0x56:
						this.ym2608?.write(op(0), op(1));
						this.pos += 2;
						break;
					case 0x57:
						this.ym2608?.write(0x100 | op(0), op(1));
						this.pos += 2;
						break;
					case 0x5a:
						this.opl2?.write(op(0), op(1));
						this.pos += 2;
						break;
					case 0x5e:
						this.opl3?.write(op(0), op(1));
						this.pos += 2;
						break;
					case 0x5f:
						this.opl3?.write(0x100 | op(0), op(1));
						this.pos += 2;
						break;
					case 0xa0: {
						const reg = op(0);
						this.ay[reg & 0x80 ? 1 : 0]?.write(reg & 0x7f, op(1));
						this.pos += 2;
						break;
					}
					case 0xb4:
						this.nes?.write(op(0), op(1));
						this.pos += 2;
						break;
					case 0x61:
						this.addWait(op(0) | (op(1) << 8));
						this.pos += 2;
						break;
					case 0x62:
						this.addWait(735);
						break;
					case 0x63:
						this.addWait(882);
						break;
					case 0x66:
						if (this.loop && this.f.loopOffset >= 0 && this.loops < 10_000) {
							this.pos = this.f.loopOffset;
							this.loops++;
						} else this.ended = true;
						break;
					case 0x67: {
						// data block: 0x66 tt ssssssss data
						const type = op(1);
						const size = (op(2) | (op(3) << 8) | (op(4) << 16) | (op(5) << 24)) >>> 0;
						const start = this.pos + 6;
						const block = d.subarray(start, start + size);
						if (type === 0x00) {
							const merged = new Uint8Array(this.pcm.length + block.length);
							merged.set(this.pcm);
							merged.set(block, this.pcm.length);
							this.pcm = merged;
						} else if (type === 0x81 && block.length > 8) {
							// YM2608 delta-T memory: total size, start address, then the data
							const startAddr = block[4] | (block[5] << 8) | (block[6] << 16) | (block[7] << 24);
							const mem = new Uint8Array(Math.max(this.deltaT.length, startAddr + block.length - 8));
							mem.set(this.deltaT);
							mem.set(block.subarray(8), startAddr);
							this.deltaT = mem;
							(this.ym2608 as unknown as { setAdpcmMemory?(d: Uint8Array): void })?.setAdpcmMemory?.(mem);
						} else if (type === 0xc2 && block.length > 2) {
							const addr = block[0] | (block[1] << 8);
							this.nesMemory.set(block.subarray(2), 0x8000 + (addr & 0x7fff));
							// the RAM block addresses are relative to $8000 in the VGM spec
						}
						this.pos = start + size;
						break;
					}
					case 0xe0:
						this.pcmPos = (op(0) | (op(1) << 8) | (op(2) << 16) | (op(3) << 24)) >>> 0;
						this.pos += 4;
						break;
					default:
						// skip the operands of commands we do not emulate
						if (cmd >= 0x30 && cmd <= 0x3f) this.pos += 1;
						else if (cmd >= 0x40 && cmd <= 0x4e) this.pos += 2;
						else if (cmd >= 0x51 && cmd <= 0x5f) this.pos += 2;
						else if (cmd >= 0xa0 && cmd <= 0xbf) this.pos += 2;
						else if (cmd >= 0xc0 && cmd <= 0xdf) this.pos += 3;
						else if (cmd >= 0xe0) this.pos += 4;
						else if (cmd === 0x68) this.pos += 11;
						else if (cmd >= 0x90 && cmd <= 0x95)
							this.pos +=
								cmd === 0x90 || cmd === 0x91
									? 4
									: cmd === 0x92
										? 5
										: cmd === 0x93
											? 10
											: cmd === 0x94
												? 1
												: 4;
						break;
				}
		}
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): number {
		let done = 0;
		while (done < count) {
			if (this.wait <= 0) this.runCommands();
			if (this.ended && this.wait <= 0) break;
			const n = Math.min(count - done, this.wait);
			if (n <= 0) continue;
			for (const c of this.chips) c.render(left, right, start + done, n);
			this.wait -= n;
			done += n;
		}
		return done;
	}
}

export function loadVgm(bytes: Uint8Array, options: LoadOptions = {}): VgmPlayer {
	return new VgmPlayer(bytes, options);
}

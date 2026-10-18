import type { Chip } from '../chips/Chip.ts';
import { createChip } from '../chips/index.ts';
import { FramePlayer, type PlayerInfo } from '../players/Player.ts';
import { Clocks, FrameRates, Region } from '../region.ts';
import { Cpu6502 } from './cpu6502.ts';
import type { InstructionSpender, LoadOptions } from './mwa.ts';

export interface PsidOptions extends LoadOptions {
	/** song number, 1-based (default: the file's start song) */
	song?: number;
	/** force the standard when the file leaves it open: 'pal' (default) or 'ntsc' */
	standard?: 'pal' | 'ntsc';
	/** force the SID model when the file leaves it open: 'mos6581' (default) or 'mos8580' */
	model?: 'mos6581' | 'mos8580';
}

export interface PsidFile {
	magic: 'PSID' | 'RSID';
	version: number;
	loadAddr: number;
	initAddr: number;
	playAddr: number;
	songs: number;
	startSong: number;
	speed: number;
	title: string;
	author: string;
	released: string;
	flags: number;
	/** SID chip addresses: 0xD400 and the extra ones of version 3/4 files */
	sidAddresses: number[];
	data: Uint8Array;
}

export function isPsid(b: Uint8Array): boolean {
	const m = String.fromCharCode(...b.subarray(0, 4));
	return (m === 'PSID' || m === 'RSID') && b.length > 0x76;
}

const str = (b: Uint8Array, o: number): string => {
	let s = '';
	for (let i = 0; i < 32 && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
	return s;
};

/** Parse a PSID / RSID file header (versions 1 to 4) */
export function parsePsid(b: Uint8Array): PsidFile {
	if (!isPsid(b)) throw new Error('not a PSID / RSID file');
	const be16 = (o: number): number => (b[o] << 8) | b[o + 1];
	const version = be16(4);
	const dataOffset = be16(6);
	let loadAddr = be16(8);
	let data = b.subarray(dataOffset);
	if (loadAddr === 0) {
		loadAddr = data[0] | (data[1] << 8);
		data = data.subarray(2);
	}
	const sidAddresses = [0xd400];
	if (version >= 3) {
		for (const o of [0x7a, 0x7b]) {
			const v = b[o];
			if (v && ((v >= 0x42 && v <= 0x7f) || (v >= 0xe0 && v <= 0xfe))) sidAddresses.push(0xd000 | (v << 4));
		}
	}
	return {
		magic: String.fromCharCode(...b.subarray(0, 4)) as 'PSID' | 'RSID',
		version,
		loadAddr,
		initAddr: be16(10),
		playAddr: be16(12),
		songs: be16(14) || 1,
		startSong: be16(16) || 1,
		speed: ((b[18] << 24) | (b[19] << 16) | (b[20] << 8) | b[21]) >>> 0,
		title: str(b, 0x16),
		author: str(b, 0x36),
		released: str(b, 0x56),
		flags: version >= 2 ? be16(0x76) : 0,
		sidAddresses,
		data: data.slice(),
	};
}

const SENTINEL = 0x0100; // return address that ends a routine (the stack page: never code)

/**
 * Plays a PSID / RSID file: the 6502 tune is executed with cycle counting on a 64 KiB C64 memory map (SID at
 * $D400, CIA timer latch, a synthetic raster counter so polling loops finish) and every SID write is timed to
 * the exact cycle inside the frame. Frame rate comes from the PAL / NTSC clock of the file (50.1245 Hz or
 * 59.826 Hz) or from the CIA 1 timer A latch for tunes flagged CIA-timed. RSID files that need a full machine
 * (raster IRQs, cartridge tricks) are played best effort.
 */
export class PsidPlayer extends FramePlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[] = [];
	private readonly cpu: Cpu6502;
	private readonly mem = new Uint8Array(0x10000);
	private readonly sids: Chip[] = [];
	private readonly pal: boolean;
	private readonly clock: number;
	private song: number;
	private started = false;
	private frameRateNow: number;
	private cia = 0;
	private frameStart = 0;
	private totalCycles = 0;
	private readonly budget?: InstructionSpender;

	constructor(
		readonly file: PsidFile,
		options: PsidOptions = {},
	) {
		super(options.sampleRate ?? 44100);
		this.budget = options.budget;
		const clockBits = (file.flags >> 2) & 3;
		this.pal =
			clockBits === 2 ? false : clockBits === 1 || clockBits === 3 ? true : (options.standard ?? 'pal') === 'pal';
		this.clock = this.pal ? Clocks.sid.pal : Clocks.sid.ntsc;
		const modelBits = (file.flags >> 4) & 3;
		const model = modelBits === 2 ? 'mos8580' : modelBits === 1 ? 'mos6581' : (options.model ?? 'mos6581');
		this.song = Math.min(Math.max(1, options.song ?? file.startSong), file.songs);
		this.frameRateNow = this.pal ? FrameRates.c64.pal : FrameRates.c64.ntsc;
		const factory = options.chipFactory ?? createChip;
		for (let i = 0; i < file.sidAddresses.length; i++) {
			const chip = factory('sid', { sampleRate: this.sampleRate, clock: this.clock, model });
			this.sids.push(chip);
			this.chips.push(chip);
		}
		this.cpu = new Cpu6502({
			read: (a) => this.read(a),
			write: (a, v) => this.write(a, v),
		});
		this.info = {
			format: file.magic.toLowerCase(),
			title: file.title || undefined,
			author: file.author || undefined,
			comment: file.released || undefined,
			chips: this.chips.map((c) => c.id),
			region: this.pal ? Region.PAL : Region.NTSC,
			frameRate: this.frameRateNow,
		};
	}

	private read(a: number): number {
		if (a >= 0xd400 && a < 0xd800) {
			for (let i = 0; i < this.file.sidAddresses.length; i++) {
				const base = this.file.sidAddresses[i];
				if (a >= base && a < base + 0x20) return this.sids[i].read(a - base);
			}
			if (a === 0xd012)
				return (Math.floor((this.totalCycles + this.cpu.cycles) / 63) % (this.pal ? 312 : 263)) & 0xff;
			if (a === 0xd011)
				return ((Math.floor((this.totalCycles + this.cpu.cycles) / 63) % (this.pal ? 312 : 263)) >> 1) & 0x80;
		}
		return this.mem[a];
	}

	private write(a: number, v: number): void {
		if (a >= 0xd400 && a < 0xd800) {
			for (let i = 0; i < this.file.sidAddresses.length; i++) {
				const base = this.file.sidAddresses[i];
				if (a >= base && a < base + 0x20) {
					const chip = this.sids[i];
					const when = ((this.cpu.cycles - this.frameStart) * this.sampleRate) / this.clock;
					this.at(when, () => chip.write(a - base, v));
					return;
				}
			}
		}
		if (a === 0xdc04) this.cia = (this.cia & 0xff00) | v;
		else if (a === 0xdc05) this.cia = (this.cia & 0xff) | (v << 8);
		this.mem[a] = v;
	}

	protected currentFrameRate(): number {
		return this.frameRateNow;
	}

	protected restart(): void {
		this.started = false;
		this.mem.fill(0);
		this.mem.set(this.file.data, this.file.loadAddr);
		this.mem[1] = 0x37;
		// the KERNAL IRQ vector points at its ROM entry; tunes overwrite it
		this.mem[0x314] = 0x31;
		this.mem[0x315] = 0xea;
		this.cia = 0;
		this.totalCycles = 0;
	}

	private run(addr: number, a: number, limit = 2_000_000): void {
		const cpu = this.cpu;
		cpu.a = a;
		cpu.x = 0;
		cpu.y = 0;
		cpu.sp = 0xfd;
		cpu.p = 0x24;
		cpu.jsr(addr, SENTINEL);
		this.runBounded(cpu.cycles + limit);
	}

	/** steps the CPU to the sentinel or the cycle limit, charging the instructions run to the budget */
	private runBounded(stop: number): void {
		const cpu = this.cpu;
		let instructions = 0;
		try {
			while (cpu.pc !== SENTINEL && cpu.cycles < stop) {
				cpu.step();
				instructions++;
			}
		} finally {
			this.budget?.spend(instructions);
		}
	}

	/** IRQ-driven tunes: enter the handler the tune installed, as the hardware IRQ would */
	private irq(): void {
		const cpu = this.cpu;
		const kernal = (this.mem[1] & 2) !== 0;
		const vec = kernal ? this.mem[0x314] | (this.mem[0x315] << 8) : this.mem[0xfffe] | (this.mem[0xffff] << 8);
		if (vec >= 0xe000 && kernal) return; // the KERNAL's own handler does nothing for the tune
		cpu.sp = 0xfd;
		cpu.push16(SENTINEL);
		cpu.pushStatus();
		cpu.pc = vec;
		cpu.p |= 4;
		this.runBounded(cpu.cycles + 2_000_000);
	}

	protected beginFrame(): boolean {
		const cpu = this.cpu;
		cpu.cycles = 0;
		this.frameStart = 0;
		if (!this.started) {
			this.started = true;
			this.mem.set(this.file.data, this.file.loadAddr);
			for (const c of this.sids) c.reset();
			this.run(this.file.initAddr || this.file.loadAddr, this.song - 1);
		}
		const ciaTimed = ((this.file.speed >>> (this.song - 1)) & 1) !== 0 && this.cia > 0;
		this.frameRateNow = ciaTimed ? this.clock / this.cia : this.pal ? FrameRates.c64.pal : FrameRates.c64.ntsc;
		if (this.file.playAddr) this.run(this.file.playAddr, 0);
		else this.irq();
		this.totalCycles += cpu.cycles;
		return true;
	}

	selectSong(n: number): void {
		this.song = Math.min(Math.max(1, n), this.file.songs);
		this.reset();
	}
}

export function loadPsid(bytes: Uint8Array, options: PsidOptions = {}): PsidPlayer {
	return new PsidPlayer(parsePsid(bytes), options);
}

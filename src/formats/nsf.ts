import type { Chip } from '../chips/Chip.ts';
import { createChip } from '../chips/index.ts';
import { FramePlayer, type PlayerInfo } from '../players/Player.ts';
import { Region } from '../region.ts';
import { Cpu6502 } from './cpu6502.ts';
import type { LoadOptions } from './mwa.ts';

export interface NsfOptions extends LoadOptions {
	/** song to play, 1-based (default: the file's start song) */
	song?: number;
}

export interface NsfFile {
	extended: boolean;
	version: number;
	songs: number;
	startSong: number;
	loadAddr: number;
	initAddr: number;
	playAddr: number;
	title: string;
	author: string;
	copyright: string;
	ripper: string;
	/** play period in microseconds for NTSC and PAL consoles */
	speedNtsc: number;
	speedPal: number;
	bankInit: Uint8Array;
	/** bit 0: PAL, bit 1: dual */
	region: number;
	/** expansion chips bitmask: 1 VRC6, 2 VRC7, 4 FDS, 8 MMC5, 16 N163, 32 Sunsoft 5B */
	expansion: number;
	data: Uint8Array;
	/** NSFE per-song data */
	trackTimesMs: number[];
	trackLabels: string[];
}

const EXPANSION_NAMES = ['VRC6', 'VRC7', 'FDS', 'MMC5', 'Namco 163', 'Sunsoft 5B'];

export function isNsf(b: Uint8Array): boolean {
	const s = String.fromCharCode(...b.subarray(0, 4));
	return (s === 'NESM' && b[4] === 0x1a) || s === 'NSFE';
}

function cstr(b: Uint8Array, o: number, n: number): string {
	let s = '';
	for (let i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]);
	return s;
}

/** Parse an `.nsf` or `.nsfe` file */
export function parseNsf(b: Uint8Array): NsfFile {
	if (!isNsf(b)) throw new Error('not an NSF file');
	const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (String.fromCharCode(...b.subarray(0, 4)) === 'NESM') {
		return {
			extended: false,
			version: b[5],
			songs: b[6],
			startSong: b[7] || 1,
			loadAddr: v.getUint16(8, true),
			initAddr: v.getUint16(10, true),
			playAddr: v.getUint16(12, true),
			title: cstr(b, 0x0e, 32),
			author: cstr(b, 0x2e, 32),
			copyright: cstr(b, 0x4e, 32),
			ripper: '',
			speedNtsc: v.getUint16(0x6e, true) || 16639,
			speedPal: v.getUint16(0x78, true) || 20000,
			bankInit: b.slice(0x70, 0x78),
			region: b[0x7a],
			expansion: b[0x7b],
			data: b.slice(0x80),
			trackTimesMs: [],
			trackLabels: [],
		};
	}
	// NSFE: chunks of [u32 length][4 byte id][data]
	const f: NsfFile = {
		extended: true,
		version: 1,
		songs: 1,
		startSong: 1,
		loadAddr: 0x8000,
		initAddr: 0,
		playAddr: 0,
		title: '',
		author: '',
		copyright: '',
		ripper: '',
		speedNtsc: 16639,
		speedPal: 20000,
		bankInit: new Uint8Array(8),
		region: 0,
		expansion: 0,
		data: new Uint8Array(0),
		trackTimesMs: [],
		trackLabels: [],
	};
	let p = 4;
	while (p + 8 <= b.length) {
		const len = v.getUint32(p, true);
		const id = String.fromCharCode(...b.subarray(p + 4, p + 8));
		const body = b.subarray(p + 8, p + 8 + len);
		const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
		if (id === 'INFO') {
			f.loadAddr = bv.getUint16(0, true);
			f.initAddr = bv.getUint16(2, true);
			f.playAddr = bv.getUint16(4, true);
			f.region = body[6];
			f.expansion = body[7];
			f.songs = body[8] ?? 1;
			f.startSong = (body[9] ?? 0) + 1;
		} else if (id === 'DATA') f.data = body.slice();
		else if (id === 'BANK') f.bankInit = body.slice(0, 8);
		else if (id === 'RATE') {
			if (len >= 2) f.speedNtsc = bv.getUint16(0, true);
			if (len >= 4) f.speedPal = bv.getUint16(2, true);
		} else if (id === 'auth') {
			const parts = String.fromCharCode(...body).split('\0');
			[f.title, f.author, f.copyright, f.ripper] = [
				parts[0] ?? '',
				parts[1] ?? '',
				parts[2] ?? '',
				parts[3] ?? '',
			];
		} else if (id === 'time') for (let i = 0; i + 4 <= len; i += 4) f.trackTimesMs.push(bv.getInt32(i, true));
		else if (id === 'tlbl') f.trackLabels = String.fromCharCode(...body).split('\0');
		else if (id === 'NEND') break;
		p += 8 + len;
	}
	return f;
}

const SENTINEL = 0x5ff0; // return address that ends a routine: never executed

class NesBus {
	readonly ram = new Uint8Array(0x800);
	readonly prgRam = new Uint8Array(0x2000);
	readonly banks = new Uint8Array(8);
	readonly banked: boolean;
	constructor(
		private readonly file: NsfFile,
		private readonly apu: Chip,
		/** called for every APU write with the current CPU cycle count */
		private readonly onApuWrite: (addr: number, value: number) => void,
		/** cartridge expansion audio: returns true when it consumed the write */
		private readonly onExpansionWrite: (addr: number, value: number) => boolean = () => false,
		private readonly onExpansionRead: (addr: number) => number | null = () => null,
	) {
		this.banked = file.bankInit.some((x) => x !== 0);
		this.banks.set(file.bankInit);
	}
	rom(addr: number): number {
		const f = this.file;
		const off = this.banked
			? this.banks[(addr - 0x8000) >> 12] * 0x1000 + (addr & 0xfff) - (f.loadAddr & 0xfff)
			: addr - f.loadAddr;
		return off >= 0 && off < f.data.length ? f.data[off] : 0;
	}
	read(addr: number): number {
		const ex = this.onExpansionRead(addr);
		if (ex !== null) return ex;
		if (addr < 0x2000) return this.ram[addr & 0x7ff];
		if (addr === 0x4015) return this.apu.read(0x4015);
		if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[addr - 0x6000];
		if (addr >= 0x8000) return this.rom(addr);
		return 0;
	}
	write(addr: number, value: number): void {
		if ((addr >= 0x4018 || addr >= 0xf800) && this.onExpansionWrite(addr, value)) return;
		if (addr < 0x2000) this.ram[addr & 0x7ff] = value;
		else if (addr >= 0x4000 && addr <= 0x4017) this.onApuWrite(addr, value);
		else if (addr >= 0x5ff8 && addr <= 0x5fff) this.banks[addr - 0x5ff8] = value;
		else if (addr >= 0x6000 && addr < 0x8000) this.prgRam[addr - 0x6000] = value;
	}
}

/**
 * Plays an NSF / NSFE file: the 6502 music code is executed for real (cycle counted) and every write to the APU
 * is timed to the exact cycle inside the frame, then the NES APU emulation renders the audio. PAL / NTSC is read
 * from the file (clock 1662607 Hz or 1789773 Hz, play rate from the header). Expansion sound chips: VRC6, MMC5
 * (pulses) and Sunsoft 5B are emulated; VRC7, FDS and Namco 163 are not (their writes are ignored and they are listed
 * in `unsupported`).
 */
export class NsfPlayer extends FramePlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[];
	readonly unsupported: string[] = [];
	private readonly apu: Chip;
	private readonly cpu: Cpu6502;
	private readonly bus: NesBus;
	private readonly pal: boolean;
	private readonly cpuClock: number;
	private readonly rate: number;
	private song: number;
	private started = false;

	constructor(
		readonly file: NsfFile,
		options: NsfOptions = {},
	) {
		super(options.sampleRate ?? 44100);
		this.pal = (file.region & 1) !== 0 && (file.region & 2) === 0;
		this.cpuClock = this.pal ? 1_662_607 : 1_789_773;
		const speed = this.pal ? file.speedPal : file.speedNtsc;
		this.rate = 1_000_000 / speed;
		this.song = Math.min(Math.max(1, options.song ?? file.startSong), Math.max(1, file.songs));
		const factory = options.chipFactory ?? createChip;
		const mem: { bus?: NesBus } = {};
		this.apu = factory('nes-apu', {
			sampleRate: this.sampleRate,
			clock: this.cpuClock,
			standard: this.pal ? 'pal' : 'ntsc',
			readMemory: (a: number) => mem.bus?.read(a) ?? 0,
		});
		this.chips = [this.apu];
		const expansion: {
			chip: Chip;
			owns: (addr: number) => boolean;
			read?: (addr: number, chip: Chip) => number | null;
		}[] = [];
		const addExpansion = (
			id: string,
			owns: (addr: number) => boolean,
			read?: (addr: number, chip: Chip) => number | null,
		): void => {
			const chip = factory(id, { sampleRate: this.sampleRate, clock: this.cpuClock });
			this.chips.push(chip);
			expansion.push({ chip, owns, read });
		};
		if (file.expansion & 1)
			addExpansion('vrc6', (a) => a >= 0x9000 && a <= 0xb003 && (a & 0xfffc) !== 0 && ((a >> 12) & 15) >= 9);
		if (file.expansion & 8) {
			const mmc5 = (a: number): boolean => (a >= 0x5000 && a <= 0x5015) || a === 0x5205 || a === 0x5206;
			addExpansion('mmc5', mmc5, (a, chip) => (a === 0x5205 || a === 0x5206 ? chip.read(a) : null));
		}
		if (file.expansion & 4)
			addExpansion(
				'fds',
				(a) => (a >= 0x4040 && a <= 0x408a) || a === 0x4090 || a === 0x4092,
				(a, chip) => ((a >= 0x4040 && a <= 0x407f) || a === 0x4090 || a === 0x4092 ? chip.read(a) : null),
			);
		if (file.expansion & 16)
			addExpansion(
				'namco163',
				(a) => (a & 0xf800) === 0x4800 || (a & 0xf800) === 0xf800,
				(a, chip) => ((a & 0xf800) === 0x4800 ? chip.read(a) : null),
			);
		if (file.expansion & 32) addExpansion('sunsoft5b', (a) => (a & 0xe000) === 0xc000 || (a & 0xe000) === 0xe000);
		const timed = (chip: Chip, addr: number, value: number): void => {
			const when = ((this.cpu.cycles - this.frameStartCycles) * this.sampleRate) / this.cpuClock;
			this.at(when, () => chip.write(addr, value));
		};
		this.bus = new NesBus(
			file,
			this.apu,
			(addr, value) => timed(this.apu, addr, value),
			(addr, value) => {
				const e = expansion.find((x) => x.owns(addr));
				if (!e) return false;
				timed(e.chip, addr, value);
				return true;
			},
			(addr) => {
				const e = expansion.find((x) => x.read && x.owns(addr));
				return e?.read ? e.read(addr, e.chip) : null;
			},
		);
		mem.bus = this.bus;
		this.cpu = new Cpu6502(this.bus);
		this.cpu.decimal = false;
		const emulated = 1 | 4 | 8 | 16 | 32;
		EXPANSION_NAMES.forEach(
			(n, i) => file.expansion & (1 << i) && !(emulated & (1 << i)) && this.unsupported.push(n),
		);
		const label = file.trackLabels[this.song - 1];
		const timeMs = file.trackTimesMs[this.song - 1];
		this.info = {
			format: file.extended ? 'nsfe' : 'nsf',
			title: [file.title, label].filter(Boolean).join(' - ') || undefined,
			author: file.author || undefined,
			comment:
				[file.copyright, this.unsupported.length ? `unsupported chips: ${this.unsupported.join(', ')}` : '']
					.filter(Boolean)
					.join(' | ') || undefined,
			chips: this.chips.map((c) => c.id),
			region: this.pal ? Region.PAL : Region.NTSC,
			frameRate: this.rate,
			durationSeconds: timeMs !== undefined && timeMs > 0 ? timeMs / 1000 : undefined,
		};
	}

	private frameStartCycles = 0;

	protected currentFrameRate(): number {
		return this.rate;
	}

	protected restart(): void {
		this.started = false;
		this.bus.ram.fill(0);
		this.bus.prgRam.fill(0);
		this.bus.banks.set(this.file.bankInit);
	}

	/** run a routine to its return, bounded in case the code never returns */
	private call(addr: number, a: number, x: number, limit = 3_000_000): void {
		const cpu = this.cpu;
		cpu.a = a;
		cpu.x = x;
		cpu.y = 0;
		cpu.sp = 0xfd;
		cpu.jsr(addr, SENTINEL);
		const stop = cpu.cycles + limit;
		while (cpu.pc !== SENTINEL && cpu.cycles < stop) cpu.step();
	}

	protected beginFrame(): boolean {
		const cpu = this.cpu;
		cpu.cycles = 0;
		this.frameStartCycles = 0;
		if (!this.started) {
			this.started = true;
			// power-up state: APU registers cleared, status enables all channels
			for (let a = 0x4000; a <= 0x4013; a++) this.apu.write(a, 0);
			this.apu.write(0x4015, 0x0f);
			this.apu.write(0x4017, 0x40);
			this.call(this.file.initAddr, this.song - 1, this.pal ? 1 : 0);
		}
		if (this.file.playAddr) this.call(this.file.playAddr, 0, 0);
		return true;
	}

	/** switch song and restart */
	selectSong(n: number): void {
		this.song = Math.min(Math.max(1, n), Math.max(1, this.file.songs));
		this.reset();
	}
}

export function loadNsf(bytes: Uint8Array, options: NsfOptions = {}): NsfPlayer {
	return new NsfPlayer(parseNsf(bytes), options);
}

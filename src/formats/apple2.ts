import type { Chip } from '../chips/Chip.ts';
import { AppleSpeaker, Mockingboard } from '../chips/AppleII.ts';
import type { PlayerInfo, RetroPlayer } from '../players/Player.ts';
import { Region } from '../region.ts';
import { Cpu6502 } from './cpu6502.ts';
import type { LoadOptions } from './mwa.ts';

export interface AppleIIOptions extends LoadOptions {
	/** 64 KiB memory image: RAM, and the ROM at $D000-$FFFF if the program needs the monitor (its IRQ vector) */
	memory: Uint8Array;
	/** address where the program starts */
	entry: number;
	/** registers at start (default 0, stack pointer $FF) */
	registers?: { a?: number; x?: number; y?: number; sp?: number };
	/** Mockingboard connector 1-7 (default 4), or 0 for no card */
	slot?: number;
	/** 'ntsc' (1.0205 MHz, default) or 'pal' (1.0157 MHz, Europlus) */
	standard?: 'ntsc' | 'pal';
	/** stop when the program counter reaches this address */
	stopAt?: number;
	/** longest run in seconds (default 120) */
	maxSeconds?: number;
}

/**
 * Plays an Apple II program: the original 6502 code runs against the real clock (1.0205 MHz) with the speaker toggle
 * at `$C030` and, in the chosen connector, the Mockingboard (2 x 6522 + 2 x AY-3-8910) whose timers interrupt the
 * CPU. Every access to the speaker is timed to its cycle inside the audio sample, the card's registers are written
 * when the CPU writes them, and the VIA interrupt vectors through the IRQ vector of the memory image ($FFFE, or
 * $03FE when that one is empty, as the monitor ROM does). This replays the music routine of a game without
 * re-implementing its driver; the program and its data must be provided in the memory image.
 */
export class AppleIIPlayer implements RetroPlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[];
	readonly sampleRate: number;
	readonly speaker: AppleSpeaker;
	readonly card: Mockingboard | null;
	private readonly cpu: Cpu6502;
	private readonly mem: Uint8Array;
	private readonly image: Uint8Array;
	private readonly slot: number;
	private readonly cps: number;
	private readonly stopAt: number | undefined;
	private readonly maxSamples: number;
	private readonly options: AppleIIOptions;
	private sampleStartCycle = 0;
	private rendered = 0;
	private accesses: number[] = [];
	private done = false;
	/** speaker toggles of the current block, as offsets in samples from its start, in time order */
	private toggles: number[] = [];
	private toggleIdx = 0;
	/** the block being rendered and how far the chips got in it */
	private block: { left: Float32Array; right: Float32Array; start: number; count: number; done: number } | null =
		null;

	constructor(options: AppleIIOptions) {
		this.options = options;
		this.sampleRate = options.sampleRate ?? 44100;
		this.image = options.memory.slice(0, 0x10000);
		this.mem = new Uint8Array(0x10000);
		this.slot = options.slot ?? 4;
		this.stopAt = options.stopAt;
		const standard = options.standard ?? 'ntsc';
		const factory = options.chipFactory;
		const make = (id: string, extra: Record<string, unknown>): Chip => {
			if (factory) return factory(id, { sampleRate: this.sampleRate, standard, ...extra });
			return id === 'apple2-speaker'
				? new AppleSpeaker({ sampleRate: this.sampleRate, standard, ...extra })
				: new Mockingboard({ sampleRate: this.sampleRate, standard, ...extra });
		};
		this.speaker = make('apple2-speaker', {}) as AppleSpeaker;
		this.card = this.slot >= 1 && this.slot <= 7 ? (make('mockingboard', {}) as Mockingboard) : null;
		if (this.card) this.card.externalClock = false;
		this.chips = this.card ? [this.speaker, this.card] : [this.speaker];
		this.cps = this.speaker.clock / this.sampleRate;
		this.maxSamples = Math.floor((options.maxSeconds ?? 120) * this.sampleRate);
		this.cpu = new Cpu6502({
			read: (a) => this.read(a),
			write: (a, v) => this.write(a, v),
		});
		this.info = {
			format: 'apple2',
			title: 'Apple II program',
			chips: this.chips.map((c) => c.id),
			region: standard === 'pal' ? Region.PAL : Region.NTSC,
			frameRate: 60,
			durationSeconds: options.maxSeconds ?? 120,
		};
		this.reset();
	}

	get finished(): boolean {
		return this.done;
	}

	reset(): void {
		this.mem.set(this.image);
		for (const c of this.chips) c.reset();
		if (this.card) this.card.externalClock = false;
		const r = this.options.registers ?? {};
		this.cpu.a = r.a ?? 0;
		this.cpu.x = r.x ?? 0;
		this.cpu.y = r.y ?? 0;
		this.cpu.sp = r.sp ?? 0xff;
		this.cpu.p = 0x24;
		this.cpu.pc = this.options.entry;
		this.cpu.cycles = 0;
		this.sampleStartCycle = 0;
		this.rendered = 0;
		this.accesses = [];
		this.toggles = [];
		this.toggleIdx = 0;
		this.block = null;
		this.done = false;
	}

	/** render the chips up to sample `target` of the current block (writes land on the right side of it) */
	private renderTo(target: number): void {
		const b = this.block;
		if (!b) return;
		const to = Math.max(b.done, Math.min(b.count, target));
		if (to === b.done) return;
		while (this.toggleIdx < this.toggles.length && this.toggles[this.toggleIdx] < to) {
			this.speaker.writeAt(this.toggles[this.toggleIdx] - b.done, 0xc030, 0);
			this.toggleIdx++;
		}
		for (const c of this.chips) c.render(b.left, b.right, b.start + b.done, to - b.done);
		b.done = to;
	}

	/** sample (fractional) of the block where the access of the running instruction happens */
	private accessSample(): number {
		return (this.cpu.cycles + 3 - this.sampleStartCycle) / this.cps;
	}

	private read(a: number): number {
		if (a >= 0xc000 && a < 0xc100) {
			if (a === 0xc030) this.accesses.push(0);
			return 0;
		}
		if (this.card && a >> 8 === 0xc0 + this.slot) {
			this.renderTo(Math.floor(this.accessSample()));
			return this.card.read(a & 0xff);
		}
		return this.mem[a];
	}

	private write(a: number, v: number): void {
		if (a >= 0xc000 && a < 0xc100) {
			if (a === 0xc030) this.accesses.push(0);
			return;
		}
		if (this.card && a >> 8 === 0xc0 + this.slot) {
			this.renderTo(Math.floor(this.accessSample()));
			this.card.write(a & 0xff, v);
			return;
		}
		if (a < 0xc000 || a >= 0xd000) this.mem[a] = v; // the ROM area is writable only as plain memory here
	}

	private irqVector(): number {
		const m = this.mem;
		const v = m[0xfffe] | (m[0xffff] << 8);
		return v ? 0xfffe : 0x03fe;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): number {
		if (this.done) return 0;
		const n = Math.min(count, this.maxSamples - this.rendered);
		if (n <= 0) {
			this.done = true;
			return 0;
		}
		const endCycle = this.sampleStartCycle + n * this.cps;
		const cpu = this.cpu;
		this.block = { left, right, start, count: n, done: 0 };
		this.toggleIdx = 0;
		while (cpu.cycles < endCycle) {
			if (this.stopAt !== undefined && cpu.pc === this.stopAt) {
				this.done = true;
				break;
			}
			const before = cpu.cycles;
			this.accesses = [];
			const used = cpu.step();
			if (this.accesses.length) {
				// the access of an instruction falls on its last cycle
				const offset = (before + used - 1 - this.sampleStartCycle) / this.cps;
				for (let i = 0; i < this.accesses.length; i++) this.toggles.push(Math.max(0, offset));
			}
			if (this.card) {
				this.card.tick(used);
				if (this.card.irq && !(cpu.p & 4)) cpu.irq(this.irqVector());
			}
		}
		this.renderTo(n);
		// toggles that fall after this block belong to the next one
		this.toggles = this.toggles.slice(this.toggleIdx).map((t) => t - n);
		this.toggleIdx = 0;
		this.block = null;
		this.sampleStartCycle = endCycle;
		this.rendered += n;
		if (this.rendered >= this.maxSamples) this.done = true;
		return n;
	}

	/** read a byte of the program memory (for tests and debugging) */
	peek(address: number): number {
		return this.mem[address & 0xffff];
	}

	setMuted(chipIndex: number, channel: number, muted: boolean): void {
		this.chips[chipIndex]?.setMuted(channel, muted);
	}
}

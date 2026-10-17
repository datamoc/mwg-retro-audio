import type { Chip, ChipOptions } from './Chip.ts';
import { Ym2149 } from './Ym2149.ts';

/**
 * The Apple II speaker: a one bit flip-flop. Any access (read or write) to the soft switch `$C030` inverts it, so the
 * sound is entirely carried by the exact cycle of every access. The output of each sample is the exact average of
 * the two-level signal over the sample: toggles can be given with a fractional position (`writeAt`), which is how a
 * 6502 running at 1.02 MHz places clicks between the 44 100 Hz samples.
 */
export class AppleSpeaker implements Chip {
	readonly id = 'apple2-speaker';
	readonly name = 'Apple II speaker (toggle at $C030)';
	readonly channels = 1;
	readonly clock: number;
	readonly sampleRate: number;
	private level = 1;
	/** toggles waiting for the next render, as fractional offsets in samples from its start */
	private pending: number[] = [];
	private muted = false;
	private readonly amplitude: number;

	constructor(options: ChipOptions & { level?: number; standard?: 'ntsc' | 'pal' } = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.clock = options.clock ?? (options.standard === 'pal' ? 1_015_657 : 1_020_484);
		this.amplitude = options.level ?? 0.5;
	}

	reset(): void {
		this.level = 1;
		this.pending = [];
	}

	/** CPU cycles per output sample */
	get cyclesPerSample(): number {
		return this.clock / this.sampleRate;
	}

	/** any access to $C030 (the address decode of the soft switch) toggles the speaker */
	private selects(addr: number): boolean {
		return (addr & 0xffff) === 0xc030 || (addr & 0xffff) === 0x30 || addr === 0x30;
	}

	write(addr: number, _value: number): void {
		if (this.selects(addr)) this.pending.push(0);
	}

	writeAt(offset: number, addr: number, _value: number): void {
		if (this.selects(addr)) this.pending.push(Math.max(0, offset));
	}

	/** reading the switch toggles it as well, and returns the floating bus (0) */
	read(addr: number): number {
		if (this.selects(addr)) this.pending.push(0);
		return 0;
	}

	setMuted(_channel: number, muted: boolean): void {
		this.muted = muted;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const toggles = this.pending.sort((a, b) => a - b);
		this.pending = [];
		let k = 0;
		for (let i = 0; i < count; i++) {
			// exact average of the signal over [i, i + 1): the level changes at each toggle inside the sample
			let t = i;
			let acc = 0;
			while (k < toggles.length && toggles[k] < i + 1) {
				const at = Math.max(t, toggles[k]);
				acc += (at - t) * this.level;
				t = at;
				this.level = -this.level;
				k++;
			}
			acc += (i + 1 - t) * this.level;
			if (!this.muted) {
				left[start + i] += acc * this.amplitude;
				right[start + i] += acc * this.amplitude;
			}
		}
		// toggles beyond this block (offset >= count) wait for the next one, shifted by the block length
		this.pending = toggles.slice(k).map((t) => t - count);
	}
}

// ------------------------------------------------------------------------------------------------ VIA 6522

const IFR_T2 = 0x20;
const IFR_T1 = 0x40;

/** MOS 6522 VIA: the part of it a sound card uses (ports, T1, T2, interrupt flags and enable) */
class Via6522 {
	ora = 0;
	orb = 0;
	ddra = 0;
	ddrb = 0;
	acr = 0;
	pcr = 0;
	ifr = 0;
	ier = 0;
	private t1Counter = 0xffff;
	private t1Latch = 0xffff;
	private t2Counter = 0xffff;
	private t2Latch = 0;
	private t1Running = false;
	private t2Running = false;

	constructor(
		/** called when the port B output changes, with the new value and the previous one */
		private readonly onPortB: (value: number, previous: number) => void,
		/** value read on port A when the AY drives the bus */
		private readonly readPortA: () => number | null,
	) {}

	reset(): void {
		this.ora = this.orb = this.ddra = this.ddrb = this.acr = this.pcr = this.ifr = this.ier = 0;
		this.t1Counter = this.t2Counter = 0xffff;
		this.t1Latch = 0xffff;
		this.t2Latch = 0;
		this.t1Running = this.t2Running = false;
	}

	get irq(): boolean {
		return (this.ifr & this.ier & 0x7f) !== 0;
	}

	/** port B as seen by the AY control lines */
	get portB(): number {
		return this.orb & this.ddrb;
	}

	write(reg: number, v: number): void {
		switch (reg & 15) {
			case 0: {
				const previous = this.portB;
				this.orb = v;
				if (this.portB !== previous) this.onPortB(this.portB, previous);
				else this.onPortB(this.portB, -1);
				break;
			}
			case 1:
			case 15:
				this.ora = v;
				break;
			case 2: {
				const previous = this.portB;
				this.ddrb = v;
				if (this.portB !== previous) this.onPortB(this.portB, previous);
				break;
			}
			case 3:
				this.ddra = v;
				break;
			case 4:
			case 6:
				this.t1Latch = (this.t1Latch & 0xff00) | v;
				break;
			case 5:
				this.t1Latch = (this.t1Latch & 0x00ff) | (v << 8);
				this.t1Counter = this.t1Latch;
				this.ifr &= ~IFR_T1;
				this.t1Running = true;
				break;
			case 7:
				this.t1Latch = (this.t1Latch & 0x00ff) | (v << 8);
				this.ifr &= ~IFR_T1;
				break;
			case 8:
				this.t2Latch = v;
				break;
			case 9:
				this.t2Counter = (v << 8) | this.t2Latch;
				this.ifr &= ~IFR_T2;
				this.t2Running = true;
				break;
			case 11:
				this.acr = v;
				break;
			case 12:
				this.pcr = v;
				break;
			case 13:
				this.ifr &= ~(v & 0x7f);
				break;
			case 14:
				this.ier = v & 0x80 ? this.ier | (v & 0x7f) : this.ier & ~(v & 0x7f);
				break;
		}
	}

	read(reg: number): number {
		switch (reg & 15) {
			case 0:
				return (this.orb & this.ddrb) | (0 & ~this.ddrb);
			case 1:
			case 15: {
				const bus = this.readPortA();
				return bus !== null ? (bus & ~this.ddra) | (this.ora & this.ddra) : this.ora;
			}
			case 2:
				return this.ddrb;
			case 3:
				return this.ddra;
			case 4:
				this.ifr &= ~IFR_T1;
				return this.t1Counter & 0xff;
			case 5:
				return this.t1Counter >> 8;
			case 6:
				return this.t1Latch & 0xff;
			case 7:
				return this.t1Latch >> 8;
			case 8:
				this.ifr &= ~IFR_T2;
				return this.t2Counter & 0xff;
			case 9:
				return this.t2Counter >> 8;
			case 11:
				return this.acr;
			case 12:
				return this.pcr;
			case 13:
				return this.ifr | (this.irq ? 0x80 : 0);
			case 14:
				return this.ier | 0x80;
			default:
				return 0;
		}
	}

	/** advance the timers by `cycles` CPU cycles */
	tick(cycles: number): void {
		for (let c = 0; c < cycles; c++) {
			if (this.t1Running) {
				if (this.t1Counter === 0) {
					this.ifr |= IFR_T1;
					if (this.acr & 0x40) this.t1Counter = this.t1Latch;
					else {
						this.t1Counter = 0xffff;
						this.t1Running = false;
					}
				} else this.t1Counter--;
			}
			if (this.t2Running) {
				if (this.t2Counter === 0) {
					this.ifr |= IFR_T2;
					this.t2Counter = 0xffff;
					this.t2Running = false;
				} else this.t2Counter--;
			}
		}
	}
}

export interface MockingboardOptions extends ChipOptions {
	/** called whenever the combined IRQ line of the two VIAs changes */
	onIrq?: (active: boolean) => void;
	/** AY-3-8910 clock = the bus clock of the Apple II (default 1020484) */
	standard?: 'ntsc' | 'pal';
}

/**
 * Sweet Micro Systems Mockingboard: two 6522 VIAs, each driving an AY-3-8910 through its ports (port A = data bus,
 * port B bit 0 = BC1, bit 1 = BDIR, bit 2 = /RESET), AY 1 to the left and AY 2 to the right speaker.
 *
 * `write(addr, value)` / `read(addr)` take the offset in the card's I/O page: 0x00-0x0F VIA 1 (the AY of the left
 * speaker), 0x80-0x8F VIA 2 (right). The sequences programs use work as on the card: `$07` on port B latches the
 * register number held on port A, `$06` writes the value of port A to the latched register, `$04` is idle (/RESET
 * high), and `$00` resets the AY. For logs of an AY alone, `write(0x100 | chip * 0x10 | register, value)` writes a
 * register directly. The VIA timers run on the CPU clock (`tick(cycles)` for a CPU-driven host, or automatically
 * while rendering) and raise the IRQ line the music routine of the game depends on.
 */
export class Mockingboard implements Chip {
	readonly id = 'mockingboard';
	readonly name = 'Mockingboard (2 x 6522 + 2 x AY-3-8910)';
	readonly channels = 6;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly via: Via6522[];
	private readonly ay: Ym2149[];
	private readonly latch = [0, 0];
	private lastIrq = false;
	private cycleCarry = 0;
	private readonly onIrq: (active: boolean) => void;

	constructor(options: MockingboardOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.clock = options.clock ?? (options.standard === 'pal' ? 1_015_657 : 1_020_484);
		this.onIrq = options.onIrq ?? (() => {});
		this.ay = [0, 1].map(() => new Ym2149({ sampleRate: this.sampleRate, clock: this.clock, model: 'ay8910' }));
		this.via = [0, 1].map(
			(i) =>
				new Via6522(
					(value, previous) => this.portB(i, value, previous),
					() => this.busRead(i),
				),
		);
	}

	reset(): void {
		for (const v of this.via) v.reset();
		for (const a of this.ay) a.reset();
		this.latch[0] = this.latch[1] = 0;
		this.cycleCarry = 0;
		this.lastIrq = false;
	}

	/** the combined interrupt request line of the card */
	get irq(): boolean {
		return this.via[0].irq || this.via[1].irq;
	}

	private updateIrq(): void {
		const now = this.irq;
		if (now !== this.lastIrq) {
			this.lastIrq = now;
			this.onIrq(now);
		}
	}

	/** the AY sees a new combination of BC1 / BDIR / RESET on port B */
	private portB(chip: number, value: number, previous: number): void {
		const via = this.via[chip];
		const ay = this.ay[chip];
		const bc1 = value & 1;
		const bdir = (value >> 1) & 1;
		const reset = (value >> 2) & 1;
		if (!reset) {
			ay.reset();
			this.latch[chip] = 0;
			return;
		}
		if (previous === value) return; // the control lines did not change
		if (bdir && bc1) this.latch[chip] = via.ora & 15;
		else if (bdir && !bc1) ay.write(this.latch[chip], via.ora);
	}

	/** value of the AY on the data bus while its control lines ask for a read (BC1 = 1, BDIR = 0) */
	private busRead(chip: number): number | null {
		const pb = this.via[chip].portB;
		return pb & 1 && !(pb & 2) ? this.ay[chip].read(this.latch[chip]) : null;
	}

	write(addr: number, value: number): void {
		const v = value & 0xff;
		if (addr >= 0x100) {
			const chip = (addr >> 4) & 1;
			this.ay[chip].write(addr & 15, v);
			return;
		}
		const a = addr & 0xff;
		this.via[a & 0x80 ? 1 : 0].write(a & 15, v);
		this.updateIrq();
	}

	read(addr: number): number {
		const a = addr & 0xff;
		const r = this.via[a & 0x80 ? 1 : 0].read(a & 15);
		this.updateIrq();
		return r;
	}

	/** advance the VIA timers by an integer number of CPU cycles (used by hosts that run a CPU) */
	tick(cycles: number): void {
		for (const v of this.via) v.tick(cycles);
		this.updateIrq();
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 6) this.ay[channel < 3 ? 0 : 1].setMuted(channel % 3, muted);
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		// the timers keep running while audio is produced (the CPU, if any, is the caller's business)
		if (this.externalClock) {
			this.cycleCarry += (count * this.clock) / this.sampleRate;
			const whole = Math.floor(this.cycleCarry);
			this.cycleCarry -= whole;
			if (whole > 0) this.tick(whole);
		}
		const l = new Float32Array(count);
		const r = new Float32Array(count);
		const unused = new Float32Array(count);
		this.ay[0].render(l, unused, 0, count);
		this.ay[1].render(r, unused, 0, count);
		for (let i = 0; i < count; i++) {
			left[start + i] += l[i];
			right[start + i] += r[i];
		}
	}

	/** when false the host calls `tick` itself (a CPU running in lockstep); default true: timers follow the audio */
	externalClock = true;
}

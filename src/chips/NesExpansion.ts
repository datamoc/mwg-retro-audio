import { Ym2149 } from './Ym2149.ts';
import { BoxRenderer } from './BoxRenderer.ts';
import type { Chip, ChipOptions } from './Chip.ts';
import { NesApu, type NesApuOptions } from './NesApu.ts';

/**
 * Konami VRC6 (Akumajou Densetsu): two pulse channels with 8 duty settings and a sawtooth, on the Famicom cartridge.
 * Registers as on the cartridge: $9000-$9003 pulse 1, $A000-$A002 pulse 2, $B000-$B002 sawtooth (pass the full CPU
 * address or the offset inside the page). Clock = the CPU clock.
 */
export class Vrc6 extends BoxRenderer implements Chip {
	readonly id = 'vrc6';
	readonly name = 'Konami VRC6';
	readonly channels = 3;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly reg = new Uint8Array(12);
	private halt = false;
	private shift = 0;
	private readonly count = [0, 0, 0];
	private readonly pos = [0, 0, 0];
	private acc = 0;
	private readonly muted = [false, false, false];

	constructor(options: ChipOptions = {}) {
		const sampleRate = options.sampleRate ?? 44100;
		const clock = options.clock ?? 1_789_773;
		super(clock / sampleRate);
		this.clock = clock;
		this.sampleRate = sampleRate;
		this.reset();
	}

	reset(): void {
		this.reg.fill(0);
		this.halt = false;
		this.shift = 0;
		this.count.fill(0);
		this.pos.fill(0);
		this.acc = 0;
		this.resetBox();
	}

	write(addr: number, value: number): void {
		const page = (addr >> 12) & 15;
		const r = addr & 3;
		if (page === 9 && r === 3) {
			this.halt = (value & 1) !== 0;
			this.shift = value & 4 ? 8 : value & 2 ? 4 : 0;
			return;
		}
		const ch = page === 9 ? 0 : page === 0xa ? 1 : page === 0xb ? 2 : -1;
		if (ch < 0 || r === 3) return;
		this.reg[ch * 4 + r] = value & 0xff;
		if (r === 2 && !(value & 0x80)) this.pos[ch] = 0;
		if (ch === 2 && r === 2 && !(value & 0x80)) this.acc = 0;
	}

	read(): number {
		return 0;
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 3) this.muted[channel] = muted;
	}

	private period(ch: number): number {
		return (this.reg[ch * 4 + 1] | ((this.reg[ch * 4 + 2] & 15) << 8)) >> this.shift;
	}

	protected step(): void {
		let out = 0;
		if (!this.halt) {
			for (let ch = 0; ch < 3; ch++) {
				if (!(this.reg[ch * 4 + 2] & 0x80)) continue;
				if (--this.count[ch] > 0) continue;
				const p = this.period(ch) + 1;
				if (ch < 2) {
					this.count[ch] = p;
					this.pos[ch] = (this.pos[ch] + 1) & 15;
				} else {
					this.count[ch] = p; // 14 ticks a cycle: CPU / (14 × (period + 1))
					this.pos[ch]++;
					if (this.pos[ch] >= 14) {
						this.pos[ch] = 0;
						this.acc = 0;
					} else if ((this.pos[ch] & 1) === 0) this.acc = (this.acc + (this.reg[8] & 63)) & 255;
				}
			}
		}
		for (let ch = 0; ch < 3; ch++) {
			if (this.muted[ch] || !(this.reg[ch * 4 + 2] & 0x80)) continue;
			if (ch < 2) {
				const r0 = this.reg[ch * 4];
				const duty = (r0 >> 4) & 7;
				if (r0 & 0x80 || this.pos[ch] <= duty) out += r0 & 15;
			} else out += this.acc >> 3;
		}
		this.curL = this.curR = (out / 61) * 0.5;
	}
}

/**
 * Sunsoft 5B (Gimmick!): the YM2149-compatible PSG of the cartridge: 3 tone channels, noise and envelope behind the
 * address port $C000 and the data port $E000. The PSG runs at half the CPU clock.
 */
export class Sunsoft5b implements Chip {
	readonly id = 'sunsoft5b';
	readonly name = 'Sunsoft 5B';
	readonly channels = 3;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly psg: Ym2149;
	private latch = 0;

	constructor(options: ChipOptions = {}) {
		this.clock = options.clock ?? 1_789_773;
		this.sampleRate = options.sampleRate ?? 44100;
		this.psg = new Ym2149({ sampleRate: this.sampleRate, clock: this.clock / 2 });
	}

	reset(): void {
		this.latch = 0;
		this.psg.reset();
	}

	write(addr: number, value: number): void {
		if ((addr & 0xe000) === 0xc000) this.latch = value & 15;
		else if ((addr & 0xe000) === 0xe000) this.psg.write(this.latch, value);
	}

	read(): number {
		return 0;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.psg.render(left, right, start, count);
	}

	setMuted(channel: number, muted: boolean): void {
		this.psg.setMuted(channel, muted);
	}
}

/**
 * Nintendo MMC5 audio: two pulse channels identical to those of the 2A03 (without sweep) at $5000-$5007 and
 * $5015, plus the 8 bit multiplier at $5205 / $5206 that some tunes use. The raw PCM channel ($5010-$5011) is not
 * modelled.
 */
export class Mmc5 implements Chip {
	readonly id = 'mmc5';
	readonly name = 'Nintendo MMC5 audio';
	readonly channels = 2;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly apu: NesApu;
	private mul = [0, 0];

	constructor(options: NesApuOptions = {}) {
		this.clock = options.clock ?? 1_789_773;
		this.sampleRate = options.sampleRate ?? 44100;
		this.apu = new NesApu({ ...options, clock: this.clock, sampleRate: this.sampleRate });
		this.noSweep();
	}

	/** frame counter in 5-step mode, and the sweep units off: the MMC5 pulses have none, so they never mute a low period */
	private noSweep(): void {
		this.apu.write(0x17, 0x40);
		this.apu.write(0x01, 0x08);
		this.apu.write(0x05, 0x08);
	}

	reset(): void {
		this.apu.reset();
		this.noSweep();
		this.mul = [0, 0];
	}

	write(addr: number, value: number): void {
		const a = addr & 0x1fff;
		if (addr === 0x5205) this.mul[0] = value & 0xff;
		else if (addr === 0x5206) this.mul[1] = value & 0xff;
		else if (a >= 0x1000 && a <= 0x1007 && a !== 0x1001 && a !== 0x1005) this.apu.write(a - 0x1000, value);
		else if (a === 0x1015) this.apu.write(0x15, value & 3);
	}

	read(addr: number): number {
		if (addr === 0x5205) return (this.mul[0] * this.mul[1]) & 0xff;
		if (addr === 0x5206) return ((this.mul[0] * this.mul[1]) >> 8) & 0xff;
		return 0;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.apu.render(left, right, start, count);
	}

	setMuted(channel: number, muted: boolean): void {
		this.apu.setMuted(channel, muted);
	}
}

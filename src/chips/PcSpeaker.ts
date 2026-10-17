import { BoxRenderer } from './BoxRenderer.ts';
import type { Chip, ChipOptions } from './Chip.ts';

/** PIT 8253 / 8254 input clock of the IBM PC */
export const PIT_CLOCK = 1_193_182;

/**
 * The 1 bit loudspeaker of the IBM PC and compatibles: PIT timer channel 2 (square wave) combined with the direct
 * speaker bit of port 0x61. Register addresses are the PC I/O ports:
 *
 * - `0x43` PIT mode register: only channel 2 (bits 7-6 = 10) is used; bits 5-4 access mode, bits 3-1 timer mode
 * - `0x42` channel 2 divisor, low byte then high byte (a divisor of 0 means 65536)
 * - `0x61` bit 0 = gate of timer 2, bit 1 = speaker enable
 *
 * The speaker is driven by `bit1 AND (bit0 ? timer output : 1)`. With the gate closed and bit 1 toggled by the
 * program this is how 1 bit digitised sound (PWM / "RealSound") was played, so register writes at sample rate
 * reproduce it exactly: each output sample is the exact average of the 1.19 MHz signal over its duration.
 * Timer modes 3 (square wave, the usual one) and 2 are modelled; one-shot modes behave like mode 3.
 */
export class PcSpeaker extends BoxRenderer implements Chip {
	readonly id = 'pc-speaker';
	readonly name = 'PC speaker (PIT 8253 channel 2)';
	readonly channels = 1;
	readonly clock = PIT_CLOCK;
	readonly sampleRate: number;
	private divisor = 0;
	private reload = 65536;
	private expectHigh = false;
	private lowByte = 0;
	private access = 3;
	private mode = 3;
	private counter = 0;
	private out = 1;
	private port61 = 0;
	private muted = false;
	/** peak amplitude of the output */
	private readonly level: number;

	constructor(options: ChipOptions & { level?: number } = {}) {
		const sampleRate = options.sampleRate ?? 44100;
		super(PIT_CLOCK / sampleRate);
		this.sampleRate = sampleRate;
		this.level = options.level ?? 0.5;
		this.reset();
	}

	reset(): void {
		this.divisor = 0;
		this.reload = 65536;
		this.expectHigh = false;
		this.counter = 0;
		this.out = 1;
		this.port61 = 0;
		this.resetBox();
	}

	write(addr: number, value: number): void {
		const v = value & 0xff;
		switch (addr & 0xff) {
			case 0x43:
				if (v >> 6 === 2) {
					this.access = (v >> 4) & 3;
					const m = (v >> 1) & 7;
					this.mode = m >= 6 ? m - 4 : m;
					this.expectHigh = false;
					this.out = 1;
				}
				break;
			case 0x42:
				if (this.access === 1) this.setDivisor(v);
				else if (this.access === 2) this.setDivisor(v << 8);
				else if (!this.expectHigh) {
					this.lowByte = v;
					this.expectHigh = true;
				} else {
					this.expectHigh = false;
					this.setDivisor((v << 8) | this.lowByte);
				}
				break;
			case 0x61:
				this.port61 = v & 3;
				break;
		}
	}

	private setDivisor(d: number): void {
		this.divisor = d;
		this.reload = d === 0 ? 65536 : d;
		if (this.counter <= 0 || this.counter > this.reload) this.counter = this.reload;
	}

	read(addr: number): number {
		return (addr & 0xff) === 0x61 ? this.port61 : 0;
	}

	setMuted(_channel: number, muted: boolean): void {
		this.muted = muted;
	}

	/** frequency of the current tone in Hz (0 when the divisor is not set) */
	get toneHz(): number {
		return this.divisor === 0 && this.reload === 65536 && this.counter === 0 ? 0 : PIT_CLOCK / this.reload;
	}

	protected step(): void {
		// the timer runs even when the gate is closed for the speaker, but stops when its own gate (bit 0) is low
		if (this.port61 & 1) {
			if (this.mode === 3) {
				this.counter -= 2;
				if (this.counter <= 0) {
					this.counter += this.reload;
					this.out ^= 1;
				}
			} else {
				this.counter -= 1;
				if (this.counter <= 0) {
					this.counter += this.reload;
					this.out = 0; // mode 2: a one tick low pulse each period
				} else this.out = 1;
			}
		} else this.out = 1;
		const drive = this.port61 & 2 ? (this.port61 & 1 ? this.out : 1) : 0;
		const s = this.muted ? 0 : drive ? this.level : -this.level;
		this.curL = this.curR = s;
	}
}

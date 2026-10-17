import { BoxRenderer } from './BoxRenderer.ts';
import type { Chip, ChipOptions } from './Chip.ts';

/** 2 dB per step, 15 = off; scaled so that three channels at full volume stay below 1.0 */
const VOLUME: number[] = (() => {
	const t: number[] = [];
	for (let i = 0; i < 15; i++) t.push(10 ** (-(i * 2) / 20));
	t.push(0);
	return t;
})();

export interface Sn76489Options extends ChipOptions {
	/**
	 * Noise shift register: 'sega' (16 bit, taps bit 0 and 3: Master System, Game Gear, Mega Drive, SG-1000) or
	 * 'ti' (15 bit, taps bit 0 and 1: BBC Micro, ColecoVision, TI-99/4A)
	 */
	variant?: 'sega' | 'ti';
	/** Game Gear style stereo register is accepted through `writeStereo` when true (default true) */
	stereo?: boolean;
}

/**
 * Texas Instruments SN76489 / SN76496 programmable sound generator: three square tone channels and one noise
 * channel with 4 bit attenuation (2 dB steps). One write port: `write(addr, value)` ignores `addr` and takes the
 * data byte as sent to the chip (bit 7 set = latch + low data bits; bit 7 clear = high data bits of the latched
 * register). Game Gear stereo is written with `writeStereo(value)`.
 *
 * Channels 0-2 are tone, channel 3 is noise.
 */
export class Sn76489 extends BoxRenderer implements Chip {
	readonly id = 'sn76489';
	readonly name = 'Texas Instruments SN76489';
	readonly channels = 4;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly tone = new Uint16Array(3);
	private readonly atten = new Uint8Array(4).fill(15);
	private noiseReg = 0;
	private latch = 0;
	private readonly counter = [0, 0, 0, 0];
	private readonly out = [1, 1, 1, 1];
	private lfsr: number;
	private readonly lfsrInit: number;
	private readonly feedbackMask: number;
	private readonly lfsrTop: number;
	private noiseDiv = 0;
	private stereoMask = 0xff;
	private readonly muted = [false, false, false, false];

	constructor(options: Sn76489Options = {}) {
		const sampleRate = options.sampleRate ?? 44100;
		const clock = options.clock ?? 3_579_545;
		// the chip divides its clock by 16 for the tone counters
		super(clock / 16 / sampleRate);
		this.clock = clock;
		this.sampleRate = sampleRate;
		const sega = (options.variant ?? 'sega') === 'sega';
		this.lfsrTop = sega ? 0x8000 : 0x4000;
		this.feedbackMask = sega ? 0x09 : 0x03;
		this.lfsrInit = this.lfsrTop;
		this.lfsr = this.lfsrInit;
		this.reset();
	}

	reset(): void {
		this.tone.fill(0);
		this.atten.fill(15);
		this.noiseReg = 0;
		this.latch = 0;
		this.counter.fill(0);
		this.out.fill(1);
		this.lfsr = this.lfsrInit;
		this.noiseDiv = 0;
		this.stereoMask = 0xff;
		this.resetBox();
	}

	write(_addr: number, value: number): void {
		const v = value & 0xff;
		if (v & 0x80) {
			this.latch = (v >> 4) & 7;
			const reg = this.latch >> 1;
			if (this.latch & 1) this.atten[reg] = v & 15;
			else if (reg < 3) this.tone[reg] = (this.tone[reg] & 0x3f0) | (v & 15);
			else this.setNoise(v & 7);
		} else {
			const reg = this.latch >> 1;
			if (this.latch & 1) this.atten[reg] = v & 15;
			else if (reg < 3) this.tone[reg] = ((v & 0x3f) << 4) | (this.tone[reg] & 15);
			else this.setNoise(v & 7);
		}
	}

	private setNoise(value: number): void {
		this.noiseReg = value;
		this.lfsr = this.lfsrInit; // writing the noise register resets the shift register
	}

	/** Game Gear stereo register: bits 0-3 right on channels 0-3, bits 4-7 left */
	writeStereo(value: number): void {
		this.stereoMask = value & 0xff;
	}

	read(addr: number): number {
		const reg = (addr & 7) >> 1;
		return (addr & 1 ? this.atten[reg] : reg < 3 ? this.tone[reg] : this.noiseReg) & 0x3ff;
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 4) this.muted[channel] = muted;
	}

	private tonePeriod(ch: number): number {
		return this.tone[ch] === 0 ? 0x400 : this.tone[ch];
	}

	protected step(): void {
		for (let ch = 0; ch < 3; ch++) {
			if (--this.counter[ch] <= 0) {
				this.counter[ch] = this.tonePeriod(ch);
				// a period of 1 is above the audible range: the real chip outputs a constant level
				this.out[ch] = this.tone[ch] === 1 ? 1 : -this.out[ch];
			}
		}
		// noise: rate 3 follows tone channel 2, otherwise /512, /1024, /2048 of the clock
		const rate = this.noiseReg & 3;
		const period = rate === 3 ? this.tonePeriod(2) : 16 << rate;
		if (--this.counter[3] <= 0) {
			this.counter[3] = period;
			this.noiseDiv ^= 1;
			if (this.noiseDiv) {
				const white = this.noiseReg & 4;
				const fb = white ? parity(this.lfsr & this.feedbackMask) : this.lfsr & 1;
				this.lfsr = (this.lfsr >> 1) | (fb ? this.lfsrTop : 0);
				this.out[3] = this.lfsr & 1 ? 1 : -1;
			}
		}
		let l = 0;
		let r = 0;
		for (let ch = 0; ch < 4; ch++) {
			if (this.muted[ch]) continue;
			const s = this.out[ch] * VOLUME[this.atten[ch]];
			if (this.stereoMask & (0x10 << ch)) l += s;
			if (this.stereoMask & (1 << ch)) r += s;
		}
		// one full-scale channel peaks at 0.25: four channels never exceed 1.0
		this.curL = l * 0.25;
		this.curR = r * 0.25;
	}
}

function parity(x: number): number {
	x ^= x >> 8;
	x ^= x >> 4;
	x ^= x >> 2;
	x ^= x >> 1;
	return x & 1;
}

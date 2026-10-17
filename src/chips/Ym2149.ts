import type { Chip, ChipOptions } from './Chip.ts';

/**
 * Volume DAC of the General Instrument AY-3-8910: 16 levels, measured on real chips (about 3 dB per step),
 * normalised to 1.0 at full scale.
 */
const AY_LEVELS = [
	0, 0.00999, 0.01445, 0.02105, 0.0307, 0.04555, 0.0645, 0.10736, 0.12659, 0.20498, 0.29221, 0.37284, 0.4986, 0.63531,
	0.80556, 1,
];

/** Volume DAC of the Yamaha YM2149: 32 levels of 1.5 dB each (the 4 bit volumes use the odd entries 1, 3, ... 31) */
const YM_LEVELS: number[] = (() => {
	const t: number[] = [0];
	for (let i = 1; i < 32; i++) t.push(10 ** (((i - 31) * 1.5) / 20));
	return t;
})();

/**
 * Envelope shapes: each of the 16 values of register 13 is three blocks of 32 steps; the first block plays once,
 * then the second and third repeat forever (a constant block makes the level hold).
 */
const GO_DOWN = 0; // 31 -> 0
const GO_UP = 1; // 0 -> 31
const LOW = 2; // held at 0
const HIGH = 3; // held at 31
const ENV_SHAPES: ReadonlyArray<readonly [number, number, number]> = [
	[GO_DOWN, LOW, LOW], // 0  \___
	[GO_DOWN, LOW, LOW], // 1  \___
	[GO_DOWN, LOW, LOW], // 2  \___
	[GO_DOWN, LOW, LOW], // 3  \___
	[GO_UP, LOW, LOW], // 4  /___
	[GO_UP, LOW, LOW], // 5  /___
	[GO_UP, LOW, LOW], // 6  /___
	[GO_UP, LOW, LOW], // 7  /___
	[GO_DOWN, GO_DOWN, GO_DOWN], // 8  \\
	[GO_DOWN, LOW, LOW], // 9  \___
	[GO_DOWN, GO_UP, GO_DOWN], // 10 \/\/
	[GO_DOWN, HIGH, HIGH], // 11 \---
	[GO_UP, GO_UP, GO_UP], // 12 ////
	[GO_UP, HIGH, HIGH], // 13 /---
	[GO_UP, GO_DOWN, GO_UP], // 14 /\/	[GO_UP, LOW, LOW], // 15 /___
];

export interface Ym2149Options extends ChipOptions {
	/**
	 * 'ym2149' (Yamaha, 32 envelope levels, Atari ST, CPC+, MSX) or 'ay8910' (General Instrument, 16 levels,
	 * ZX Spectrum, CPC)
	 */
	model?: 'ym2149' | 'ay8910';
	/**
	 * Atari ST output stage: the DC-coupled asymmetric RC low-pass of the STF between the chip and the monitor
	 * (fast rise, slow fall) followed by AC coupling. Off by default.
	 */
	atariStOutput?: boolean;
	/** stereo placement of channels A, B, C as pan values from -1 (left) to 1 (right); default centre for all */
	pan?: [number, number, number];
}

/**
 * Yamaha YM2149 / General Instrument AY-3-8910: three square-wave channels, a noise generator shared by all of
 * them and one hardware envelope, as found on the Atari ST, Amstrad CPC, MSX and ZX Spectrum 128.
 *
 * The chip is run at its internal step (master clock / 8) and each output sample is the exact average of the
 * steps it covers, so register tricks that change the sound faster than the frame rate (SID voice, sync-buzzer,
 * digidrums made with the volume register) are reproduced as they happen.
 *
 * Registers 0-15 as on the real chip: 0-5 tone periods, 6 noise period, 7 mixer (bits 0-2 tone off, 3-5 noise
 * off), 8-10 volume (bit 4 = use the envelope), 11-12 envelope period, 13 envelope shape.
 */
export class Ym2149 implements Chip {
	readonly id = 'ym2149';
	readonly name: string;
	readonly channels = 3;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly regs = new Uint8Array(16);
	private readonly levels: readonly number[];
	private readonly five: boolean;
	private readonly muted = [false, false, false];
	private readonly panGains: [number, number][];
	private readonly stOutput: boolean;
	private readonly ticksPerSample: number;

	private toneCount = [0, 0, 0];
	private tonePhase = [0, 0, 0];
	private noiseCount = 0;
	private noiseRng = 1;
	private noiseBit = 0;
	private noiseDiv = 0;
	private envCount = 0;
	private envPos = 0;
	private envShape = 0;
	private tickLeft = 0;
	private curL = 0;
	private curR = 0;
	private stY = 0;
	private stX1 = 0;
	private dcX1 = 0;
	private dcY1 = 0;

	constructor(options: Ym2149Options = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.clock = options.clock ?? 2_000_000;
		const model = options.model ?? 'ym2149';
		this.name = model === 'ym2149' ? 'Yamaha YM2149' : 'General Instrument AY-3-8910';
		this.five = model === 'ym2149';
		this.levels = this.five ? YM_LEVELS : AY_LEVELS;
		this.stOutput = options.atariStOutput ?? false;
		// without an explicit pan every channel feeds both outputs at full level (plain mono); with one, equal-power pan
		this.panGains = options.pan
			? options.pan.map((p) => {
					const a = ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4;
					return [Math.cos(a), Math.sin(a)] as [number, number];
				})
			: [
					[1, 1],
					[1, 1],
					[1, 1],
				];
		this.ticksPerSample = this.clock / 8 / this.sampleRate;
		this.reset();
	}

	reset(): void {
		this.regs.fill(0);
		this.regs[7] = 0xff;
		this.toneCount = [0, 0, 0];
		this.tonePhase = [0, 0, 0];
		this.noiseCount = 0;
		this.noiseRng = 1;
		this.noiseBit = 0;
		this.noiseDiv = 0;
		this.envCount = 0;
		this.envPos = 0;
		this.envShape = 0;
		this.tickLeft = 0;
		this.curL = this.curR = 0;
		this.stY = this.stX1 = this.dcX1 = this.dcY1 = 0;
	}

	write(addr: number, value: number): void {
		const r = addr & 15;
		let v = value & 0xff;
		if (r === 1 || r === 3 || r === 5 || r === 13) v &= 0x0f;
		else if (r === 6 || (r >= 8 && r <= 10)) v &= 0x1f;
		this.regs[r] = v;
		if (r === 13) {
			// writing the shape restarts the envelope
			this.envShape = v;
			this.envPos = 0;
			this.envCount = 0;
		}
	}

	read(addr: number): number {
		return this.regs[addr & 15];
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 3) this.muted[channel] = muted;
	}

	/** tone period of a channel, a value of 0 behaves as 1 like on the real chip */
	private tonePeriod(ch: number): number {
		return Math.max(1, this.regs[ch * 2] | ((this.regs[ch * 2 + 1] & 15) << 8));
	}

	/** envelope level 0-31 at the current position */
	private envLevel(): number {
		const kind = ENV_SHAPES[this.envShape][this.envPos >> 5];
		const i = this.envPos & 31;
		switch (kind) {
			case GO_DOWN:
				return 31 - i;
			case GO_UP:
				return i;
			case HIGH:
				return 31;
			default:
				return 0;
		}
	}

	/** advance the chip by one internal step (master clock / 8) and compute the instantaneous output */
	private step(): void {
		const regs = this.regs;
		for (let ch = 0; ch < 3; ch++) {
			if (++this.toneCount[ch] >= this.tonePeriod(ch)) {
				this.toneCount[ch] = 0;
				this.tonePhase[ch] ^= 1;
			}
		}
		// the noise generator runs at half the tone rate (master clock / 16)
		this.noiseDiv ^= 1;
		if (this.noiseDiv === 0 && ++this.noiseCount >= Math.max(1, regs[6])) {
			this.noiseCount = 0;
			const fb = this.noiseRng & 1;
			this.noiseRng >>= 1;
			if (fb) this.noiseRng ^= 0x12000;
			this.noiseBit = fb;
		}
		const envPeriod = Math.max(1, regs[11] | (regs[12] << 8));
		if (++this.envCount >= envPeriod) {
			this.envCount = 0;
			if (++this.envPos >= 96) this.envPos = 32; // blocks 2 and 3 repeat
		}

		const env = this.envLevel();
		let l = 0;
		let r = 0;
		for (let ch = 0; ch < 3; ch++) {
			if (this.muted[ch]) continue;
			const toneOn = (regs[7] >> ch) & 1 ? 1 : this.tonePhase[ch];
			const noiseOn = (regs[7] >> (ch + 3)) & 1 ? 1 : this.noiseBit;
			if (!(toneOn & noiseOn)) continue;
			const vreg = regs[8 + ch];
			let level: number;
			if (vreg & 0x10) level = this.levels[this.five ? env : env >> 1];
			else level = this.levels[this.five ? (vreg & 15 ? (vreg & 15) * 2 + 1 : 0) : vreg & 15];
			l += level * this.panGains[ch][0];
			r += level * this.panGains[ch][1];
		}
		l /= 3;
		r /= 3;
		if (this.stOutput) {
			// Atari STF output: pulls up quickly, falls slowly (C10 / R8 of the schematics), then AC coupling
			const x = (l + r) / 2;
			this.stY = x >= this.stY ? (3 * (x + this.stX1) + 2 * this.stY) / 8 : (x + this.stX1 + 6 * this.stY) / 8;
			this.stX1 = x;
			l = r = this.stY;
		}
		this.curL = l;
		this.curR = r;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const tps = this.ticksPerSample;
		const dcPole = this.stOutput ? Math.exp((-2 * Math.PI * 14) / this.sampleRate) : 0;
		for (let i = 0; i < count; i++) {
			let need = tps;
			let accL = 0;
			let accR = 0;
			while (need > 1e-9) {
				if (this.tickLeft <= 1e-9) {
					this.step();
					this.tickLeft = 1;
				}
				const take = Math.min(need, this.tickLeft);
				accL += this.curL * take;
				accR += this.curR * take;
				need -= take;
				this.tickLeft -= take;
			}
			let l = accL / tps;
			let r = accR / tps;
			if (this.stOutput) {
				const y = l - this.dcX1 + dcPole * this.dcY1;
				this.dcX1 = l;
				this.dcY1 = y;
				l = r = y;
			}
			left[start + i] += l;
			right[start + i] += r;
		}
	}
}

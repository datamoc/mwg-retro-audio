import { BoxRenderer } from './BoxRenderer.ts';
import type { Chip, ChipOptions } from './Chip.ts';

const LENGTH_TABLE = [
	10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16,
	28, 32, 30,
];
const DUTY = [
	[0, 1, 0, 0, 0, 0, 0, 0],
	[0, 1, 1, 0, 0, 0, 0, 0],
	[0, 1, 1, 1, 1, 0, 0, 0],
	[1, 0, 0, 1, 1, 1, 1, 1],
];
const NOISE_NTSC = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const NOISE_PAL = [4, 8, 14, 30, 60, 88, 118, 148, 188, 236, 354, 472, 708, 944, 1890, 3778];
const DMC_NTSC = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const DMC_PAL = [398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50];
const TRIANGLE = [
	15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
];

/** non-linear mixer of the 2A03, as measured: pulse 95.88 / (8128 / n + 100), tnd 159.79 / (1 / (t/8227 + n/12241 + d/22638) + 100) */
const PULSE_MIX = new Float32Array(31);
for (let n = 1; n < 31; n++) PULSE_MIX[n] = 95.88 / (8128 / n + 100);
const TND_MIX = new Float32Array(203);
for (let n = 1; n < 203; n++) TND_MIX[n] = 159.79 / (1 / (n / 22638) + 100);

export interface NesApuOptions extends ChipOptions {
	/** 'ntsc' (2A03, default) or 'pal' (2A07): decides the noise and DPCM rate tables and the frame counter */
	standard?: 'ntsc' | 'pal';
	/** read a byte of the CPU address space for DPCM samples ($C000-$FFFF) */
	readMemory?: (address: number) => number;
	/** called when the DMC or frame counter raises an IRQ */
	onIrq?: () => void;
}

class Envelope {
	start = false;
	loop = false;
	constant = false;
	period = 0;
	divider = 0;
	decay = 0;
	clock(): void {
		if (this.start) {
			this.start = false;
			this.decay = 15;
			this.divider = this.period;
		} else if (this.divider-- <= 0) {
			this.divider = this.period;
			if (this.decay > 0) this.decay--;
			else if (this.loop) this.decay = 15;
		}
	}
	volume(): number {
		return this.constant ? this.period : this.decay;
	}
}

class Pulse {
	readonly env = new Envelope();
	enabled = false;
	length = 0;
	duty = 0;
	timer = 0;
	counter = 0;
	seq = 0;
	haltLength = false;
	sweepEnabled = false;
	sweepPeriod = 0;
	sweepNegate = false;
	sweepShift = 0;
	sweepDivider = 0;
	sweepReload = false;
	constructor(private readonly ones: boolean) {}

	private target(): number {
		const delta = this.timer >> this.sweepShift;
		// pulse 1 uses one's complement, pulse 2 two's complement
		return this.sweepNegate ? this.timer - delta - (this.ones ? 1 : 0) : this.timer + delta;
	}
	private muted(): boolean {
		return this.timer < 8 || this.target() > 0x7ff;
	}
	clockSweep(): void {
		if (this.sweepDivider === 0 && this.sweepEnabled && this.sweepShift > 0 && !this.muted()) {
			this.timer = this.target();
		}
		if (this.sweepDivider === 0 || this.sweepReload) {
			this.sweepDivider = this.sweepPeriod;
			this.sweepReload = false;
		} else this.sweepDivider--;
	}
	clockLength(): void {
		if (!this.haltLength && this.length > 0) this.length--;
	}
	/** one APU cycle (every second CPU cycle) */
	tick(): void {
		if (this.counter-- <= 0) {
			this.counter = this.timer;
			this.seq = (this.seq + 1) & 7;
		}
	}
	output(): number {
		if (!this.enabled || this.length === 0 || this.muted() || !DUTY[this.duty][this.seq]) return 0;
		return this.env.volume();
	}
}

/**
 * Ricoh 2A03 / 2A07 audio processing unit of the NES / Famicom: two pulse channels (12.5 / 25 / 50 / 75 % duty,
 * envelope, sweep, length counter), a triangle with a linear counter, an LFSR noise channel (long and short modes)
 * and the DPCM channel, combined with the console's non-linear mixer. Registers are $4000-$4017: pass either the
 * full CPU address or the offset 0-0x17.
 *
 * Channels: 0 pulse 1, 1 pulse 2, 2 triangle, 3 noise, 4 DPCM. The frame counter runs in 4 or 5 step mode as
 * selected by $4017 and drives envelopes, sweeps and length counters at their real rates.
 */
export class NesApu extends BoxRenderer implements Chip {
	readonly id = 'nes-apu';
	readonly name = 'Ricoh 2A03 APU';
	readonly channels = 5;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly p1 = new Pulse(true);
	private readonly p2 = new Pulse(false);
	private readonly noiseTable: number[];
	private readonly dmcTable: number[];
	private readonly pal: boolean;
	private readonly readMem: (address: number) => number;
	private readonly onIrq: () => void;
	private readonly muted = [false, false, false, false, false];

	// triangle
	private triEnabled = false;
	private triLength = 0;
	private triHalt = false;
	private triLinearReload = 0;
	private triLinear = 0;
	private triReloadFlag = false;
	private triTimer = 0;
	private triCounter = 0;
	private triSeq = 0;
	// noise
	private readonly noiseEnv = new Envelope();
	private noiseEnabled = false;
	private noiseLength = 0;
	private noiseHalt = false;
	private noiseShort = false;
	private noisePeriodIdx = 0;
	private noiseCounter = 0;
	private noiseShift = 1;
	// dmc
	private dmcEnabled = false;
	private dmcIrqEnabled = false;
	private dmcLoop = false;
	private dmcPeriod = 428;
	private dmcCounter = 0;
	private dmcLevel = 0;
	private dmcSampleAddr = 0xc000;
	private dmcSampleLen = 1;
	private dmcAddr = 0xc000;
	private dmcRemaining = 0;
	private dmcBuffer = -1;
	private dmcShift = 0;
	private dmcBits = 0;
	private dmcSilence = true;
	private dmcIrq = false;
	// frame counter
	private frameMode5 = false;
	private frameIrqInhibit = false;
	private frameIrq = false;
	private frameCycle = 0;
	private cpuCycle = 0;

	constructor(options: NesApuOptions = {}) {
		const pal = options.standard === 'pal';
		const sampleRate = options.sampleRate ?? 44100;
		const clock = options.clock ?? (pal ? 1_662_607 : 1_789_773);
		super(clock / sampleRate);
		this.pal = pal;
		this.clock = clock;
		this.sampleRate = sampleRate;
		this.noiseTable = pal ? NOISE_PAL : NOISE_NTSC;
		this.dmcTable = pal ? DMC_PAL : DMC_NTSC;
		this.readMem = options.readMemory ?? (() => 0);
		this.onIrq = options.onIrq ?? (() => {});
		this.reset();
	}

	reset(): void {
		for (const p of [this.p1, this.p2]) {
			p.enabled = false;
			p.length = 0;
			p.timer = 0;
			p.duty = 0;
			p.seq = 0;
			p.counter = 0;
			p.env.period = 0;
			p.env.decay = 0;
			p.env.constant = false;
			p.sweepEnabled = false;
			p.haltLength = false;
		}
		this.triEnabled = false;
		this.triLength = 0;
		this.triTimer = 0;
		this.triSeq = 16; // the table's ascending zero: a stopped triangle feeds the mixer with nothing
		this.triLinear = 0;
		this.noiseEnabled = false;
		this.noiseLength = 0;
		this.noiseShift = 1;
		this.noiseEnv.decay = 0;
		this.noiseEnv.period = 0;
		this.dmcEnabled = false;
		this.dmcRemaining = 0;
		this.dmcLevel = 0;
		this.dmcBuffer = -1;
		this.dmcSilence = true;
		this.dmcIrq = false;
		this.frameIrq = false;
		this.frameMode5 = false;
		this.frameCycle = 0;
		this.cpuCycle = 0;
		this.hpX = this.hpY = 0;
		this.resetBox();
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 5) this.muted[channel] = muted;
	}

	write(addr: number, value: number): void {
		const a = addr >= 0x4000 ? addr - 0x4000 : addr;
		const v = value & 0xff;
		switch (a) {
			case 0x00:
			case 0x04: {
				const p = a === 0 ? this.p1 : this.p2;
				p.duty = v >> 6;
				p.haltLength = (v & 0x20) !== 0;
				p.env.loop = p.haltLength;
				p.env.constant = (v & 0x10) !== 0;
				p.env.period = v & 15;
				break;
			}
			case 0x01:
			case 0x05: {
				const p = a === 1 ? this.p1 : this.p2;
				p.sweepEnabled = (v & 0x80) !== 0;
				p.sweepPeriod = (v >> 4) & 7;
				p.sweepNegate = (v & 8) !== 0;
				p.sweepShift = v & 7;
				p.sweepReload = true;
				break;
			}
			case 0x02:
			case 0x06: {
				const p = a === 2 ? this.p1 : this.p2;
				p.timer = (p.timer & 0x700) | v;
				break;
			}
			case 0x03:
			case 0x07: {
				const p = a === 3 ? this.p1 : this.p2;
				p.timer = (p.timer & 0xff) | ((v & 7) << 8);
				if (p.enabled) p.length = LENGTH_TABLE[v >> 3];
				p.seq = 0;
				p.env.start = true;
				break;
			}
			case 0x08:
				this.triHalt = (v & 0x80) !== 0;
				this.triLinearReload = v & 0x7f;
				break;
			case 0x0a:
				this.triTimer = (this.triTimer & 0x700) | v;
				break;
			case 0x0b:
				this.triTimer = (this.triTimer & 0xff) | ((v & 7) << 8);
				if (this.triEnabled) this.triLength = LENGTH_TABLE[v >> 3];
				this.triReloadFlag = true;
				break;
			case 0x0c:
				this.noiseHalt = (v & 0x20) !== 0;
				this.noiseEnv.loop = this.noiseHalt;
				this.noiseEnv.constant = (v & 0x10) !== 0;
				this.noiseEnv.period = v & 15;
				break;
			case 0x0e:
				this.noiseShort = (v & 0x80) !== 0;
				this.noisePeriodIdx = v & 15;
				break;
			case 0x0f:
				if (this.noiseEnabled) this.noiseLength = LENGTH_TABLE[v >> 3];
				this.noiseEnv.start = true;
				break;
			case 0x10:
				this.dmcIrqEnabled = (v & 0x80) !== 0;
				if (!this.dmcIrqEnabled) this.dmcIrq = false;
				this.dmcLoop = (v & 0x40) !== 0;
				this.dmcPeriod = this.dmcTable[v & 15];
				break;
			case 0x11:
				this.dmcLevel = v & 0x7f;
				break;
			case 0x12:
				this.dmcSampleAddr = 0xc000 | (v << 6);
				break;
			case 0x13:
				this.dmcSampleLen = (v << 4) | 1;
				break;
			case 0x15:
				this.p1.enabled = (v & 1) !== 0;
				this.p2.enabled = (v & 2) !== 0;
				this.triEnabled = (v & 4) !== 0;
				this.noiseEnabled = (v & 8) !== 0;
				if (!this.p1.enabled) this.p1.length = 0;
				if (!this.p2.enabled) this.p2.length = 0;
				if (!this.triEnabled) this.triLength = 0;
				if (!this.noiseEnabled) this.noiseLength = 0;
				this.dmcIrq = false;
				if (v & 16) {
					if (this.dmcRemaining === 0) {
						this.dmcAddr = this.dmcSampleAddr;
						this.dmcRemaining = this.dmcSampleLen;
						this.fillDmcBuffer();
					}
				} else this.dmcRemaining = 0;
				this.dmcEnabled = (v & 16) !== 0;
				break;
			case 0x17:
				this.frameMode5 = (v & 0x80) !== 0;
				this.frameIrqInhibit = (v & 0x40) !== 0;
				if (this.frameIrqInhibit) this.frameIrq = false;
				this.frameCycle = 0;
				if (this.frameMode5) {
					this.clockQuarter();
					this.clockHalf();
				}
				break;
		}
	}

	/** $4015: channel length status and IRQ flags (reading clears the frame IRQ) */
	read(addr: number): number {
		const a = addr >= 0x4000 ? addr - 0x4000 : addr;
		if (a !== 0x15) return 0;
		const v =
			(this.p1.length > 0 ? 1 : 0) |
			(this.p2.length > 0 ? 2 : 0) |
			(this.triLength > 0 ? 4 : 0) |
			(this.noiseLength > 0 ? 8 : 0) |
			(this.dmcRemaining > 0 ? 16 : 0) |
			(this.frameIrq ? 0x40 : 0) |
			(this.dmcIrq ? 0x80 : 0);
		this.frameIrq = false;
		return v;
	}

	private clockQuarter(): void {
		this.p1.env.clock();
		this.p2.env.clock();
		this.noiseEnv.clock();
		if (this.triReloadFlag) this.triLinear = this.triLinearReload;
		else if (this.triLinear > 0) this.triLinear--;
		if (!this.triHalt) this.triReloadFlag = false;
	}

	private clockHalf(): void {
		this.p1.clockLength();
		this.p2.clockLength();
		this.p1.clockSweep();
		this.p2.clockSweep();
		if (!this.triHalt && this.triLength > 0) this.triLength--;
		if (!this.noiseHalt && this.noiseLength > 0) this.noiseLength--;
	}

	private clockFrame(): void {
		// CPU cycles of the sequencer: 3729 / 7457 / 11186 / 14915 (4 step, IRQ at the end) or ... / 18641 (5 step)
		switch (this.frameCycle) {
			case 3729:
			case 11186:
				this.clockQuarter();
				break;
			case 7457:
				this.clockQuarter();
				this.clockHalf();
				break;
			case 14915:
				if (!this.frameMode5) {
					this.clockQuarter();
					this.clockHalf();
					if (!this.frameIrqInhibit) {
						this.frameIrq = true;
						this.onIrq();
					}
				}
				break;
			case 18641:
				this.clockQuarter();
				this.clockHalf();
				break;
		}
	}

	private fillDmcBuffer(): void {
		if (this.dmcBuffer >= 0 || this.dmcRemaining === 0) return;
		this.dmcBuffer = this.readMem(this.dmcAddr) & 0xff;
		this.dmcAddr = this.dmcAddr === 0xffff ? 0x8000 : this.dmcAddr + 1;
		if (--this.dmcRemaining === 0) {
			if (this.dmcLoop) {
				this.dmcAddr = this.dmcSampleAddr;
				this.dmcRemaining = this.dmcSampleLen;
			} else if (this.dmcIrqEnabled) {
				this.dmcIrq = true;
				this.onIrq();
			}
		}
	}

	protected step(): void {
		// one CPU cycle
		this.cpuCycle++;
		this.frameCycle++;
		if (this.frameMode5 ? this.frameCycle > 18641 : this.frameCycle > 14915) this.frameCycle = 0;
		this.clockFrame();

		// triangle runs at the CPU rate, the others at half of it
		if (this.triCounter-- <= 0) {
			this.triCounter = this.triTimer;
			if (this.triLength > 0 && this.triLinear > 0 && this.triTimer >= 2) this.triSeq = (this.triSeq + 1) & 31;
		}
		if ((this.cpuCycle & 1) === 0) {
			this.p1.tick();
			this.p2.tick();
			if (this.noiseCounter-- <= 0) {
				this.noiseCounter = this.noiseTable[this.noisePeriodIdx] / 2 - 1;
				const bit = this.noiseShort ? 6 : 1;
				const fb = (this.noiseShift & 1) ^ ((this.noiseShift >> bit) & 1);
				this.noiseShift = (this.noiseShift >> 1) | (fb << 14);
			}
		}
		if (this.dmcEnabled || this.dmcRemaining > 0 || this.dmcBits > 0) {
			if (this.dmcCounter-- <= 0) {
				this.dmcCounter = this.dmcPeriod - 1;
				if (!this.dmcSilence) {
					if (this.dmcShift & 1) {
						if (this.dmcLevel <= 125) this.dmcLevel += 2;
					} else if (this.dmcLevel >= 2) this.dmcLevel -= 2;
					this.dmcShift >>= 1;
				}
				if (--this.dmcBits <= 0) {
					this.dmcBits = 8;
					if (this.dmcBuffer >= 0) {
						this.dmcSilence = false;
						this.dmcShift = this.dmcBuffer;
						this.dmcBuffer = -1;
						this.fillDmcBuffer();
					} else this.dmcSilence = true;
				}
			}
		}

		const p1 = this.muted[0] ? 0 : this.p1.output();
		const p2 = this.muted[1] ? 0 : this.p2.output();
		const tri = this.muted[2] ? 0 : TRIANGLE[this.triSeq];
		const noise = this.muted[3] || this.noiseLength === 0 || this.noiseShift & 1 ? 0 : this.noiseEnv.volume();
		const dmc = this.muted[4] ? 0 : this.dmcLevel;
		const out = PULSE_MIX[p1 + p2] + TND_MIX[3 * tri + 2 * noise + dmc];
		this.curL = this.curR = out;
	}

	private hpX = 0;
	private hpY = 0;

	/** the console output stage: a 37 Hz high-pass removes the DC offset of the unipolar mixer */
	protected override post(l: number, _r: number, out: [number, number]): void {
		const k = Math.exp((-2 * Math.PI * 37) / this.sampleRate);
		const y = l - this.hpX + k * this.hpY;
		this.hpX = l;
		this.hpY = y;
		out[0] = out[1] = y;
	}

	/** true for a 2A07 */
	get isPal(): boolean {
		return this.pal;
	}
}

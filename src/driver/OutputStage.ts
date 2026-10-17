/**
 * Layer 3 - the output stage of a retro machine.
 *
 * What gives a chip its character is not only its oscillators but also how the signal leaves the machine: a
 * band-limited analogue stage, a DC-coupled output, and, for the 8-bit converters of the Mega Drive or the NES, a
 * DAC that is neither perfectly linear nor perfectly accurate. This module models those three things on raw
 * stereo buffers so they apply the same way offline and in the streaming path.
 */

/** Second-order low-pass (RBJ cookbook biquad), direct form I, one instance per channel */
export class BiquadLowpass {
	private b0 = 1;
	private b1 = 0;
	private b2 = 0;
	private a1 = 0;
	private a2 = 0;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;

	constructor(
		readonly sampleRate: number,
		cutoff: number,
		readonly q = Math.SQRT1_2,
	) {
		this.setCutoff(cutoff);
	}

	setCutoff(cutoff: number): void {
		// a cut-off at or above Nyquist is a pass-through
		const fc = Math.min(cutoff, this.sampleRate * 0.499);
		const w0 = (2 * Math.PI * fc) / this.sampleRate;
		const cos = Math.cos(w0);
		const alpha = Math.sin(w0) / (2 * this.q);
		const a0 = 1 + alpha;
		this.b0 = (1 - cos) / 2 / a0;
		this.b1 = (1 - cos) / a0;
		this.b2 = (1 - cos) / 2 / a0;
		this.a1 = (-2 * cos) / a0;
		this.a2 = (1 - alpha) / a0;
	}

	process(x: number): number {
		const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}

	reset(): void {
		this.x1 = this.x2 = this.y1 = this.y2 = 0;
	}
}

/** First-order high-pass that removes the DC level of a unipolar output (AC coupling of the real machine) */
export class DcBlocker {
	private x1 = 0;
	private y1 = 0;
	private readonly r: number;

	constructor(sampleRate: number, cutoff = 5) {
		this.r = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
	}

	process(x: number): number {
		const y = x - this.x1 + this.r * this.y1;
		this.x1 = x;
		this.y1 = y;
		return y;
	}

	reset(): void {
		this.x1 = this.y1 = 0;
	}
}

/** Reduce a [-1, 1] sample to a signed converter of `bits` bits (round to nearest step) */
export function quantize(x: number, bits: number): number {
	const levels = 2 ** (bits - 1);
	return Math.max(-1, Math.min(1 - 1 / levels, Math.round(x * levels) / levels));
}

/**
 * Crossover distortion of a ladder DAC: the part of the signal around zero is flattened by a dead band, then the
 * rest is rescaled so full scale is preserved. `amount` is the dead-band half width as a fraction of full scale
 * (the YM2612 shows about 0.01 - 0.03, an ideal converter 0).
 */
export function crossover(x: number, amount: number): number {
	if (amount <= 0) return x;
	const a = Math.abs(x);
	if (a <= amount) return 0;
	return Math.sign(x) * ((a - amount) / (1 - amount));
}

export interface OutputStageOptions {
	/** anti-aliasing low-pass cut-off in Hz; omit or 0 to disable (default: none) */
	lowpass?: number;
	/** order of the low-pass: 1 = one biquad (12 dB/oct), 2 = two in series (24 dB/oct); default 1 */
	lowpassOrder?: 1 | 2;
	/** remove the DC component (default false) */
	dcBlock?: boolean;
	/** DC blocker cut-off in Hz (default 5) */
	dcCutoff?: number;
	/** simulated converter resolution in bits (default: ideal) */
	dacBits?: number;
	/** dead band of the ladder DAC, fraction of full scale (default 0) */
	dacCrossover?: number;
	/** final gain (default 1) */
	gain?: number;
}

/** Stereo output stage applying, in order: DAC non-linearity, anti-aliasing low-pass, DC removal, gain */
export class OutputStage {
	private readonly filters: BiquadLowpass[][] = [];
	private readonly dc: DcBlocker[] = [];
	private readonly opts: Required<OutputStageOptions>;

	constructor(
		readonly sampleRate: number,
		options: OutputStageOptions = {},
	) {
		this.opts = {
			lowpass: options.lowpass ?? 0,
			lowpassOrder: options.lowpassOrder ?? 1,
			dcBlock: options.dcBlock ?? false,
			dcCutoff: options.dcCutoff ?? 5,
			dacBits: options.dacBits ?? 0,
			dacCrossover: options.dacCrossover ?? 0,
			gain: options.gain ?? 1,
		};
		for (let ch = 0; ch < 2; ch++) {
			const chain: BiquadLowpass[] = [];
			if (this.opts.lowpass > 0) {
				for (let i = 0; i < this.opts.lowpassOrder; i++)
					chain.push(new BiquadLowpass(sampleRate, this.opts.lowpass));
			}
			this.filters.push(chain);
			this.dc.push(new DcBlocker(sampleRate, this.opts.dcCutoff));
		}
	}

	/** process `count` frames in place starting at `start` */
	process(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const { dacBits, dacCrossover, dcBlock, gain } = this.opts;
		const bufs = [left, right];
		for (let ch = 0; ch < 2; ch++) {
			const buf = bufs[ch];
			const chain = this.filters[ch];
			const dc = this.dc[ch];
			for (let i = start; i < start + count; i++) {
				let x = buf[i];
				if (dacCrossover > 0) x = crossover(x, dacCrossover);
				if (dacBits > 0) x = quantize(x, dacBits);
				for (const f of chain) x = f.process(x);
				if (dcBlock) x = dc.process(x);
				buf[i] = x * gain;
			}
		}
	}

	reset(): void {
		for (const chain of this.filters) for (const f of chain) f.reset();
		for (const d of this.dc) d.reset();
	}
}

/**
 * Output stage presets for original analogue paths (spec section 7). They are plain `OutputStageOptions`, so they
 * can be spread and adjusted: `new OutputStage(rate, { ...OutputProfiles.pcSpeaker, gain: 2 })`.
 */
export const OutputProfiles = {
	/** the small speaker of an IBM PC: no bass, nothing above about 5 kHz */
	pcSpeaker: { lowpass: 5000, lowpassOrder: 2, dcBlock: true, dcCutoff: 300 } satisfies OutputStageOptions,
	/** AdLib card: 9 bit OPL DAC with its dead band, then a gentle low-pass */
	adlibCard: { dacBits: 9, dacCrossover: 0.004, lowpass: 16000, dcBlock: true } satisfies OutputStageOptions,
	/** Sound Blaster DSP output filter for a sample rate: anti-aliasing at 40 % of the rate */
	soundBlasterDac: (sampleRateOfSound: number): OutputStageOptions => ({
		lowpass: Math.min(12000, 0.4 * sampleRateOfSound),
		lowpassOrder: 2,
		dcBlock: true,
	}),
	/** Mega Drive: YM2612 9 bit DAC with ladder effect and the console's low-pass */
	megaDrive: { dacBits: 9, dacCrossover: 0.01, lowpass: 3390, dcBlock: true } satisfies OutputStageOptions,
	/** NES / Famicom: RF-ish low-pass and the 37 Hz high-pass already in the APU */
	nes: { lowpass: 14000, dcBlock: true, dcCutoff: 14 } satisfies OutputStageOptions,
	/** Atari ST monitor path */
	atariSt: { lowpass: 15000, dcBlock: true, dcCutoff: 14 } satisfies OutputStageOptions,
} as const;

/**
 * Band-limited resampler for chips that produce audio at their own native rate (FM chips: OPL at clock / 72,
 * YM2612 at clock / 144). Windowed-sinc interpolation with a table of fractional delays.
 */

/** native sample generator: fills `n` frames of stereo audio at the chip's own rate (overwriting) */
export type NativeGenerator = (left: Float32Array, right: Float32Array, n: number) => void;

const TAPS = 24;
const PHASES = 512;
const BLOCK = 32; // small, so register writes reach the audio with under a millisecond of latency

function bessel0(x: number): number {
	let sum = 1;
	let term = 1;
	for (let k = 1; k < 30; k++) {
		term *= (x / (2 * k)) ** 2;
		sum += term;
	}
	return sum;
}

/** table[phase][tap]: windowed-sinc weights for a fractional position, cut-off scaled for down-sampling */
function buildKernel(cutoff: number): Float32Array {
	const table = new Float32Array((PHASES + 1) * TAPS);
	const beta = 8.6; // Kaiser window, about 90 dB stop-band
	const half = TAPS / 2;
	for (let p = 0; p <= PHASES; p++) {
		const frac = p / PHASES;
		let sum = 0;
		for (let t = 0; t < TAPS; t++) {
			const x = t - half + 1 - frac; // distance of the tap from the interpolation point
			const arg = Math.PI * x * cutoff;
			const sinc = Math.abs(arg) < 1e-9 ? 1 : Math.sin(arg) / arg;
			const r = x / half;
			const win = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / bessel0(beta);
			const w = sinc * win * cutoff;
			table[p * TAPS + t] = w;
			sum += w;
		}
		for (let t = 0; t < TAPS; t++) table[p * TAPS + t] /= sum; // unity DC gain
	}
	return table;
}

/** Resamples a stream from `srcRate` to `dstRate`, pulling native frames from `generate` as needed */
export class SincResampler {
	private readonly kernel: Float32Array;
	private readonly step: number;
	private inL: Float32Array;
	private inR: Float32Array;
	/** read position in source frames, relative to the start of the buffer (fractional) */
	private pos = 0;
	private filled = 0;

	constructor(
		readonly srcRate: number,
		readonly dstRate: number,
		private readonly generate: NativeGenerator,
	) {
		this.step = srcRate / dstRate;
		this.kernel = buildKernel(Math.min(1, dstRate / srcRate));
		this.inL = new Float32Array(BLOCK * 4 + TAPS);
		this.inR = new Float32Array(BLOCK * 4 + TAPS);
		this.reset();
	}

	reset(): void {
		this.inL.fill(0);
		this.inR.fill(0);
		// start with silence history so the first output has full context
		this.filled = TAPS;
		this.pos = TAPS / 2;
	}

	/** ADD `count` output frames into left/right from `start` */
	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const half = TAPS / 2;
		for (let i = 0; i < count; i++) {
			// ensure source frames up to floor(pos) + half exist
			while (Math.floor(this.pos) + half + 1 > this.filled) this.refill();
			const i0 = Math.floor(this.pos);
			const frac = this.pos - i0;
			const phase = Math.min(PHASES - 1, Math.floor(frac * PHASES));
			const mix = frac * PHASES - phase;
			const k0 = phase * TAPS;
			const k1 = k0 + TAPS;
			let l = 0;
			let r = 0;
			const base = i0 - half + 1;
			for (let t = 0; t < TAPS; t++) {
				const w = this.kernel[k0 + t] * (1 - mix) + this.kernel[k1 + t] * mix;
				l += this.inL[base + t] * w;
				r += this.inR[base + t] * w;
			}
			left[start + i] += l;
			right[start + i] += r;
			this.pos += this.step;
		}
	}

	private refill(): void {
		// drop consumed frames, keeping TAPS of history
		const keepFrom = Math.max(0, Math.floor(this.pos) - TAPS);
		if (keepFrom > 0) {
			this.inL.copyWithin(0, keepFrom, this.filled);
			this.inR.copyWithin(0, keepFrom, this.filled);
			this.filled -= keepFrom;
			this.pos -= keepFrom;
		}
		const tmpL = new Float32Array(BLOCK);
		const tmpR = new Float32Array(BLOCK);
		this.generate(tmpL, tmpR, BLOCK);
		this.inL.set(tmpL, this.filled);
		this.inR.set(tmpR, this.filled);
		this.filled += BLOCK;
	}
}

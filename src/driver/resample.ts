/**
 * Offline sample-rate conversion of a whole stereo buffer, for export (Opus wants 48 kHz, the chips render at the
 * rate of the audio context). Windowed-sinc with a Kaiser window, no delay: output frame `i` is the input at time
 * `i * srcRate / dstRate`. Down-sampling lowers the cut-off to the new Nyquist frequency.
 */

const HALF_TAPS = 32; // 64 taps: flat to about 20 kHz when going from 44.1 to 48 kHz
const PHASES = 256;

function bessel0(x: number): number {
	let sum = 1;
	let term = 1;
	for (let k = 1; k < 40; k++) {
		term *= (x / (2 * k)) ** 2;
		sum += term;
	}
	return sum;
}

function kernel(cutoff: number): Float32Array {
	const table = new Float32Array((PHASES + 1) * 2 * HALF_TAPS);
	const beta = 8.6;
	const norm = bessel0(beta);
	for (let p = 0; p <= PHASES; p++) {
		const frac = p / PHASES;
		let sum = 0;
		for (let t = 0; t < 2 * HALF_TAPS; t++) {
			const x = t - HALF_TAPS + 1 - frac;
			const arg = Math.PI * x * cutoff;
			const sinc = Math.abs(arg) < 1e-9 ? 1 : Math.sin(arg) / arg;
			const r = x / HALF_TAPS;
			const win = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / norm;
			const w = sinc * win;
			table[p * 2 * HALF_TAPS + t] = w;
			sum += w;
		}
		for (let t = 0; t < 2 * HALF_TAPS; t++) table[p * 2 * HALF_TAPS + t] /= sum;
	}
	return table;
}

/** Convert one channel from `srcRate` to `dstRate` (returns the input itself when the rates are equal) */
export function resampleChannel(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
	if (srcRate === dstRate) return input;
	const outLength = Math.round((input.length * dstRate) / srcRate);
	const out = new Float32Array(outLength);
	const step = srcRate / dstRate;
	const taps = 2 * HALF_TAPS;
	// leave a little room below Nyquist when going down; going up keeps the whole band
	const table = kernel(Math.min(1, (dstRate / srcRate) * 0.97));
	const n = input.length;
	for (let i = 0; i < outLength; i++) {
		const pos = i * step;
		const i0 = Math.floor(pos);
		const frac = pos - i0;
		const phase = Math.min(PHASES - 1, Math.floor(frac * PHASES));
		const mix = frac * PHASES - phase;
		const k0 = phase * taps;
		const k1 = k0 + taps;
		let acc = 0;
		const base = i0 - HALF_TAPS + 1;
		for (let t = 0; t < taps; t++) {
			const j = base + t;
			if (j < 0 || j >= n) continue;
			acc += input[j] * (table[k0 + t] * (1 - mix) + table[k1 + t] * mix);
		}
		out[i] = acc;
	}
	return out;
}

export function resampleStereo(
	left: Float32Array,
	right: Float32Array,
	srcRate: number,
	dstRate: number,
): [Float32Array, Float32Array] {
	return [resampleChannel(left, srcRate, dstRate), resampleChannel(right, srcRate, dstRate)];
}

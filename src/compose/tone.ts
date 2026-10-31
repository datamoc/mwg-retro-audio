import { BAND_TOP, fft, meanBandShape } from '../driver/analysis.ts';

const BANDS = 32;
const LOW = 60;
/** natural-log power to decibels */
const DB_PER_LOG = 10 / Math.LN10;

/** Centre frequency of band `k` of a band shape */
const bandCentre = (k: number, rate: number): number => {
	const high = Math.min(rate * 0.45, BAND_TOP);
	return LOW * (high / LOW) ** ((k + 0.5) / BANDS);
};

/**
 * Per band gain in dB that moves the spectral shape of `mix` towards `target` (both 32 band shapes with the level
 * removed, see `meanBandShape`). `amount` is the share of the difference that is corrected, and no band moves by
 * more than `limit` dB.
 */
export function toneMatchGains(
	mix: Float32Array,
	target: readonly number[],
	rate: number,
	amount = 0.85,
	limit = 9,
): number[] {
	const current = meanBandShape(mix, rate);
	return current.map((c, k) => Math.max(-limit, Math.min(limit, (target[k] - c) * DB_PER_LOG * amount)));
}

/**
 * Apply per band gains (dB) to a looping signal with an overlap-add filter bank. The signal is treated as circular,
 * so the start and the end of a loop stay continuous (it is filtered with its own end and start as padding). The gains are interpolated between the band centres.
 */
export function applyToneGains(channels: readonly Float32Array[], gainsDb: readonly number[], rate: number): void {
	const size = 2 ** Math.round(Math.log2(rate * 0.093));
	const hop = size / 2;
	const response = new Float64Array(size / 2 + 1);
	for (let bin = 0; bin <= size / 2; bin++) {
		const hz = (bin * rate) / size;
		let position = 0;
		if (hz > bandCentre(0, rate)) {
			position = BANDS - 1;
			for (let k = 0; k < BANDS - 1; k++)
				if (hz <= bandCentre(k + 1, rate)) {
					const a = bandCentre(k, rate);
					const b = bandCentre(k + 1, rate);
					position = k + Math.log(hz / a) / Math.log(b / a);
					break;
				}
		}
		const k0 = Math.floor(position);
		const k1 = Math.min(BANDS - 1, k0 + 1);
		const db = gainsDb[k0] + (gainsDb[k1] - gainsDb[k0]) * (position - k0);
		response[bin] = 10 ** (db / 20);
	}
	for (const x of channels) {
		// the loop is padded with its own end and start, then filtered as a straight signal and cut back: no seam
		const n = x.length;
		const pad = size;
		const extended = new Float32Array(n + 2 * pad);
		for (let i = 0; i < extended.length; i++) extended[i] = x[(((i - pad) % n) + n) % n];
		const out = new Float32Array(extended.length);
		for (let start = 0; start + size <= extended.length; start += hop) {
			const re = new Float64Array(size);
			const im = new Float64Array(size);
			for (let i = 0; i < size; i++)
				re[i] = extended[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
			fft(re, im);
			for (let bin = 0; bin <= size / 2; bin++) {
				re[bin] *= response[bin];
				im[bin] *= response[bin];
				if (bin > 0 && bin < size / 2) {
					re[size - bin] *= response[bin];
					im[size - bin] *= response[bin];
				}
			}
			// inverse FFT through the forward one: conjugate, transform, conjugate, scale
			for (let i = 0; i < size; i++) im[i] = -im[i];
			fft(re, im);
			for (let i = 0; i < size; i++) out[start + i] += re[i] / size;
		}
		x.set(out.subarray(pad, pad + n));
	}
}

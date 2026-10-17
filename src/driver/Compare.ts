/** Result of comparing a rendering with a reference (an emulator capture, another engine, a previous run) */
export interface AudioComparison {
	/** root mean square of the difference divided by the root mean square of the reference, after alignment */
	relativeError: number;
	/** shift in samples applied to `rendered` to line it up with `reference` (positive: rendered is late) */
	lag: number;
	/** true when `relativeError` is within the tolerance */
	ok: boolean;
	/** samples compared */
	length: number;
}

/**
 * Compare a rendering with a reference signal sample by sample, as the conformance tests of the specification ask for
 * ("reproduced against a capture, with an explicit tolerance"). Both signals have their DC removed; `maxLag` lets the
 * comparison absorb a constant latency such as a filter delay, and `normalizeGain` finds the best overall level
 * first (a comparison of shape and timing only, when two chains do not share the same output level).
 */
export function compareAudio(
	rendered: Float32Array,
	reference: Float32Array,
	options: { tolerance?: number; maxLag?: number; from?: number; to?: number; normalizeGain?: boolean } = {},
): AudioComparison {
	const tolerance = options.tolerance ?? 0.05;
	const maxLag = options.maxLag ?? 0;
	const from = options.from ?? 0;
	const to = Math.min(options.to ?? Infinity, rendered.length, reference.length);
	const mean = (x: Float32Array): number => {
		let m = 0;
		for (let i = from; i < to; i++) m += x[i];
		return m / Math.max(1, to - from);
	};
	const mr = mean(rendered);
	const mf = mean(reference);
	let best = { error: Infinity, lag: 0 };
	let energy = 0;
	for (let i = from + maxLag; i < to - maxLag; i++) energy += (reference[i] - mf) ** 2;
	for (let lag = -maxLag; lag <= maxLag; lag++) {
		let dot = 0;
		let own = 0;
		for (let i = from + maxLag; i < to - maxLag; i++) {
			const a = rendered[i + lag] - mr;
			dot += a * (reference[i] - mf);
			own += a * a;
		}
		const gain = options.normalizeGain && own > 0 ? dot / own : 1;
		let diff = 0;
		for (let i = from + maxLag; i < to - maxLag; i++)
			diff += (gain * (rendered[i + lag] - mr) - (reference[i] - mf)) ** 2;
		if (diff < best.error) best = { error: diff, lag };
	}
	const relativeError = energy > 0 ? Math.sqrt(best.error / energy) : best.error > 0 ? Infinity : 0;
	return {
		relativeError,
		lag: best.lag,
		ok: relativeError <= tolerance,
		length: Math.max(0, to - from - 2 * maxLag),
	};
}

function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		for (let i = 0; i < n; i += len) {
			for (let k = 0; k < len / 2; k++) {
				const wr = Math.cos(ang * k);
				const wi = Math.sin(ang * k);
				const ur = re[i + k];
				const ui = im[i + k];
				const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
				const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
				re[i + k] = ur + vr;
				im[i + k] = ui + vi;
				re[i + k + len / 2] = ur - vr;
				im[i + k + len / 2] = ui - vi;
			}
		}
	}
}

/**
 * Compare two signals by their short-time magnitude spectra instead of sample by sample: the oscillator phases of two
 * emulations of the same chip are free (they depend on how the counters started), so a square wave tune cannot match
 * a reference waveform sample for sample but must match its spectrum. Each frame is windowed (Hann), transformed, and
 * the two magnitude spectra are compared on a log scale after a per-signal level normalisation (the output levels of
 * two chains differ); the result is the mean absolute difference in decibels over the bins that matter, and the
 * share of reference energy bins whose level agrees within `binToleranceDb`.
 */
export function compareSpectra(
	rendered: Float32Array,
	reference: Float32Array,
	options: { frame?: number; hop?: number; binToleranceDb?: number; floorDb?: number } = {},
): { meanDb: number; agreement: number; frames: number } {
	const frame = options.frame ?? 4096;
	const hop = options.hop ?? frame;
	const tol = options.binToleranceDb ?? 6;
	const floor = options.floorDb ?? -60;
	const n = Math.min(rendered.length, reference.length);
	const win = Float64Array.from({ length: frame }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame));
	const spectrum = (x: Float32Array, at: number): Float64Array => {
		const re = new Float64Array(frame);
		const im = new Float64Array(frame);
		let mean = 0;
		for (let i = 0; i < frame; i++) mean += x[at + i];
		mean /= frame;
		for (let i = 0; i < frame; i++) re[i] = (x[at + i] - mean) * win[i];
		fft(re, im);
		return Float64Array.from({ length: frame / 2 }, (_, k) => Math.hypot(re[k], im[k]));
	};
	let sumDb = 0;
	let count = 0;
	let agree = 0;
	let relevant = 0;
	let frames = 0;
	for (let at = 0; at + frame <= n; at += hop) {
		const a = spectrum(rendered, at);
		const b = spectrum(reference, at);
		const peakA = Math.max(...a, 1e-12);
		const peakB = Math.max(...b, 1e-12);
		frames++;
		for (let k = 1; k < a.length; k++) {
			const da = 20 * Math.log10(Math.max(a[k] / peakA, 1e-9));
			const db = 20 * Math.log10(Math.max(b[k] / peakB, 1e-9));
			if (da < floor && db < floor) continue;
			const d = Math.abs(Math.max(da, floor) - Math.max(db, floor));
			sumDb += d;
			count++;
			if (db >= -30) {
				relevant++;
				if (d <= tol) agree++;
			}
		}
	}
	return { meanDb: count ? sumDb / count : 0, agreement: relevant ? agree / relevant : 1, frames };
}

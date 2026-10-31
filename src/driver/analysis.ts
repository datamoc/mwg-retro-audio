/** Audio analysis used to compare a rendering with a reference: tempo, pitch classes and spectral distance */

/** Tempo candidates in BPM, best first, from the autocorrelation of the onset strength (10 ms frames) */
export function estimateTempo(samples: Float32Array, sampleRate: number, low = 70, high = 200): number[] {
	const hop = Math.round(sampleRate * 0.01);
	const frames = Math.floor(samples.length / hop);
	const energy = new Float64Array(frames);
	for (let f = 0; f < frames; f++) {
		let e = 0;
		for (let i = 0; i < hop; i++) e += samples[f * hop + i] ** 2;
		energy[f] = Math.log(1e-6 + e / hop);
	}
	const onset = new Float64Array(frames);
	for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
	const mean = onset.reduce((a, c) => a + c, 0) / Math.max(1, frames);
	for (let f = 0; f < frames; f++) onset[f] -= mean;
	const scores: { bpm: number; score: number }[] = [];
	for (let bpm = low; bpm <= high; bpm += 0.25) {
		const lag = 6000 / bpm;
		let score = 0;
		for (let m = 1; m <= 4; m++) {
			const l = lag * m;
			for (let f = 0; f + l + 1 < frames; f++) {
				const i = Math.floor(f + l);
				const w = f + l - i;
				score += onset[f] * (onset[i] * (1 - w) + onset[i + 1] * w);
			}
		}
		scores.push({ bpm, score });
	}
	scores.sort((a, b) => b.score - a.score);
	const result: number[] = [];
	for (const c of scores) if (result.length < 4 && result.every((t) => Math.abs(t - c.bpm) > 3)) result.push(c.bpm);
	return result;
}

/** Energy in each pitch class (C = 0), normalised to sum to 1, over MIDI notes `low`..`high` (Goertzel bank) */
export function pitchClassProfile(samples: Float32Array, sampleRate: number, low = 36, high = 95): Float64Array {
	const profile = new Float64Array(12);
	const n = Math.round(sampleRate * 0.37); // a fixed duration, so the result does not depend on the sample rate
	const step = Math.round(sampleRate * 0.5);
	for (let start = 0; start + n < samples.length; start += step)
		for (let midi = low; midi <= high; midi++) {
			const cw = 2 * Math.cos((2 * Math.PI * 440 * 2 ** ((midi - 69) / 12)) / sampleRate);
			let s1 = 0;
			let s2 = 0;
			for (let i = 0; i < n; i++) {
				const s0 = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)) + cw * s1 - s2;
				s2 = s1;
				s1 = s0;
			}
			profile[midi % 12] += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - cw * s1 * s2));
		}
	const total = profile.reduce((a, c) => a + c, 0) || 1;
	for (let i = 0; i < 12; i++) profile[i] /= total;
	return profile;
}

/** In-place radix-2 FFT (the length must be a power of two) */
export function fft(re: Float64Array, im: Float64Array): void {
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
		const angle = (-2 * Math.PI) / len;
		for (let i = 0; i < n; i += len)
			for (let k = 0; k < len / 2; k++) {
				const wr = Math.cos(angle * k);
				const wi = Math.sin(angle * k);
				const a = i + k;
				const c = a + len / 2;
				const tr = re[c] * wr - im[c] * wi;
				const ti = re[c] * wi + im[c] * wr;
				re[c] = re[a] - tr;
				im[c] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
			}
	}
}

/** Upper edge of the band spectra in Hz: fixed, so band shapes of different sample rates can be compared */
export const BAND_TOP = 9900;

/** Log spectrum in `bands` equally spaced bands on a log frequency axis (60 Hz .. 9.9 kHz) per frame */
function logBands(samples: Float32Array, sampleRate: number, frame: number, bands: number): number[][] {
	const result: number[][] = [];
	const high = Math.min(sampleRate * 0.45, BAND_TOP);
	for (let start = 0; start + frame <= samples.length; start += frame) {
		const re = new Float64Array(frame);
		const im = new Float64Array(frame);
		for (let i = 0; i < frame; i++) re[i] = samples[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame));
		fft(re, im);
		const row = new Array<number>(bands).fill(0);
		for (let b = 0; b < bands; b++) {
			const from = Math.max(1, Math.floor((60 * (high / 60) ** (b / bands) * frame) / sampleRate));
			const to = Math.max(from + 1, Math.floor((60 * (high / 60) ** ((b + 1) / bands) * frame) / sampleRate));
			let e = 0;
			for (let k = from; k < to; k++) e += re[k] * re[k] + im[k] * im[k];
			row[b] = Math.log(1e-9 + e / (to - from));
		}
		result.push(row);
	}
	return result;
}

/**
 * Mean absolute difference, in natural-log power units, between the band spectra of two signals (frames of 2048
 * samples, 32 bands). 0 means identical spectra frame by frame; the result is insensitive to phase.
 */
export function spectralDistance(a: Float32Array, b: Float32Array, sampleRate: number): number {
	const x = logBands(a, sampleRate, 2048, 32);
	const y = logBands(b, sampleRate, 2048, 32);
	const frames = Math.min(x.length, y.length);
	if (frames === 0) return Infinity;
	let sum = 0;
	for (let f = 0; f < frames; f++) for (let k = 0; k < 32; k++) sum += Math.abs(x[f][k] - y[f][k]);
	return sum / (frames * 32);
}

/**
 * Average log spectrum in 32 bands on a log frequency axis (60 Hz .. 9.9 kHz), with the overall level
 * removed: the spectral shape of a piece, to compare the tone colour of two recordings that differ in loudness.
 */
export function meanBandShape(samples: Float32Array, sampleRate: number): number[] {
	const frame = 2 ** Math.round(Math.log2(sampleRate * 0.093));
	const rows = logBands(samples, sampleRate, frame, 32);
	const mean = new Array<number>(32).fill(0);
	for (const row of rows) for (let k = 0; k < 32; k++) mean[k] += row[k] / Math.max(1, rows.length);
	const level = mean.reduce((a, c) => a + c, 0) / 32;
	return mean.map((v) => v - level);
}

/** Mean absolute difference between two band shapes (natural-log power units) */
export function bandShapeDistance(a: readonly number[], b: readonly number[]): number {
	let sum = 0;
	for (let k = 0; k < a.length; k++) sum += Math.abs(a[k] - b[k]);
	return sum / a.length;
}

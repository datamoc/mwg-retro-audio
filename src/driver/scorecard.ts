import { estimateTempo, pitchClassProfile, spectralDistance } from './analysis.ts';

/** How close a rendering is to a reference, metric by metric (all measured, none is a pass / fail verdict) */
export interface Scorecard {
	/** relative difference of the best tempo estimates (0.01 = 1 %) */
	tempoError: number;
	/** half the L1 distance between the pitch class profiles, 0 (same) to 1 (disjoint) */
	pitchClassDistance: number;
	/** mean relative difference of the 100 ms loudness envelopes after matching the overall level */
	loudnessError: number;
	/** mean absolute log-power difference of the band spectra, see `spectralDistance` */
	spectralDistance: number;
}

/** 100 ms RMS envelope */
function envelope(x: Float32Array, rate: number): number[] {
	const n = Math.round(rate * 0.1);
	const result: number[] = [];
	for (let start = 0; start + n <= x.length; start += n) {
		let e = 0;
		for (let i = 0; i < n; i++) e += x[start + i] ** 2;
		result.push(Math.sqrt(e / n));
	}
	return result;
}

/** Score `rendered` against `reference` (mono, same sample rate; the shorter one decides the compared length) */
export function scoreRendering(rendered: Float32Array, reference: Float32Array, sampleRate: number): Scorecard {
	const length = Math.min(rendered.length, reference.length);
	const a = rendered.subarray(0, length);
	const b = reference.subarray(0, length);
	const [tempoA] = estimateTempo(a, sampleRate);
	const [tempoB] = estimateTempo(b, sampleRate);
	const pa = pitchClassProfile(a, sampleRate);
	const pb = pitchClassProfile(b, sampleRate);
	let pitchClassDistance = 0;
	for (let i = 0; i < 12; i++) pitchClassDistance += Math.abs(pa[i] - pb[i]);
	const ea = envelope(a, sampleRate);
	const eb = envelope(b, sampleRate);
	const sumA = ea.reduce((s, v) => s + v, 0);
	const sumB = eb.reduce((s, v) => s + v, 0);
	const gain = sumA > 0 ? sumB / sumA : 1;
	let loudness = 0;
	for (let i = 0; i < ea.length; i++) loudness += Math.abs(ea[i] * gain - eb[i]) / Math.max(eb[i], 1e-4);
	return {
		tempoError: Math.abs(tempoA - tempoB) / tempoB,
		pitchClassDistance: pitchClassDistance / 2,
		loudnessError: ea.length ? loudness / ea.length : 0,
		spectralDistance: spectralDistance(a, b, sampleRate),
	};
}

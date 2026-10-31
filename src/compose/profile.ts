import { bandShapeDistance, estimateTempo, fft, meanBandShape, pitchClassProfile } from '../driver/analysis.ts';
import type { Cue } from './composeCue.ts';
import { SCALES, type StyleSpec } from './styles.ts';

/** What a cue of a style must look like, derived from the style itself */
export interface StyleProfile {
	tempo: number;
	/** pitch classes of the scale of the style */
	scalePitchClasses: readonly number[];
	/** least share of the pitch class energy that must fall on the scale */
	minScaleShare: number;
	centroidRange: readonly [number, number];
	/** most relative tempo error allowed */
	tempoTolerance: number;
	/** the tone colour of the style (see `StyleSpec.toneTarget`) and the largest band shape distance allowed from it */
	toneTarget?: readonly number[];
	toneTolerance: number;
}

export function styleProfile(style: StyleSpec): StyleProfile {
	return {
		tempo: style.tempo,
		scalePitchClasses: SCALES[style.mode].map((s) => (style.tonic + s) % 12),
		minScaleShare: 0.7,
		centroidRange: style.centroidRange,
		tempoTolerance: 0.01,
		toneTarget: style.toneTarget,
		toneTolerance: style.toneTolerance ?? 0.6,
	};
}

export interface CueCheck {
	/** relative error of the measured tempo (a tempo estimator may answer the half or double, those count) */
	tempoError: number;
	/** share of the pitch class energy on the scale of the style, 0..1 */
	scaleShare: number;
	/** mean spectral centroid in Hz */
	centroid: number;
	tempoOk: boolean;
	pitchOk: boolean;
	/** band shape distance from the tone target of the style (0 when the style has none) */
	toneDistance: number;
	spectrumOk: boolean;
	toneOk: boolean;
	ok: boolean;
}

/** Mean spectral centroid below 10 kHz (so it does not depend on the sample rate) of 24 frames of about 186 ms */
export function meanCentroid(x: Float32Array, sampleRate: number): number {
	const size = 2 ** Math.round(Math.log2(sampleRate * 0.186)); // about 186 ms at any sample rate
	const frames = 24;
	let sum = 0;
	let counted = 0;
	for (let f = 0; f < frames; f++) {
		const start = Math.floor(((x.length - size) * f) / (frames - 1));
		if (start < 0) break;
		const re = new Float64Array(size);
		const im = new Float64Array(size);
		for (let i = 0; i < size; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
		fft(re, im);
		let weighted = 0;
		let total = 0;
		for (let k = 1; k < Math.min(size / 2, Math.floor((10000 * size) / sampleRate)); k++) {
			const m = Math.hypot(re[k], im[k]);
			weighted += m * k;
			total += m;
		}
		if (total > 0) {
			sum += ((weighted / total) * sampleRate) / size;
			counted++;
		}
	}
	return counted ? sum / counted : 0;
}

/** Measure a rendered cue against the profile of its style */
export function checkCue(cue: Cue): CueCheck {
	const profile = styleProfile(cue.style);
	const mono = new Float32Array(cue.left.length);
	for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (cue.left[i] + cue.right[i]);
	const tempoError = Math.min(
		...estimateTempo(mono, cue.sampleRate, 60, 300)
			.slice(0, 2)
			.flatMap((bpm) => [1, 2, 0.5].map((m) => Math.abs(bpm * m - profile.tempo) / profile.tempo)),
	);
	// from C3 up: below about 130 Hz the analysis window cannot separate neighbouring semitones, so bass leaks off the scale
	const classes = pitchClassProfile(mono, cue.sampleRate, 48, 95);
	const scaleShare = profile.scalePitchClasses.reduce((s, pc) => s + classes[pc], 0);
	const centroid = meanCentroid(mono, cue.sampleRate);
	const tempoOk = tempoError <= profile.tempoTolerance;
	const pitchOk = scaleShare >= profile.minScaleShare;
	const spectrumOk = centroid >= profile.centroidRange[0] && centroid <= profile.centroidRange[1];
	const toneDistance = profile.toneTarget
		? bandShapeDistance(meanBandShape(mono, cue.sampleRate), profile.toneTarget)
		: 0;
	const toneOk = toneDistance <= profile.toneTolerance;
	return {
		tempoError,
		scaleShare,
		centroid,
		tempoOk,
		pitchOk,
		toneDistance,
		spectrumOk,
		toneOk,
		ok: tempoOk && pitchOk && spectrumOk && toneOk,
	};
}

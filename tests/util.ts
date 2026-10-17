import type { Chip } from '../src/chips/Chip.ts';

export const RATE = 44100;

export function renderMono(chip: Chip, seconds: number): Float32Array {
	const n = Math.floor(seconds * chip.sampleRate);
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	chip.render(l, r, 0, n);
	return l;
}

export function renderStereo(chip: Chip, seconds: number): [Float32Array, Float32Array] {
	const n = Math.floor(seconds * chip.sampleRate);
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	chip.render(l, r, 0, n);
	return [l, r];
}

/** frequency from the time between the first and the last rising crossing of the mean (linear interpolation) */
export function frequency(x: Float32Array, rate: number, start = 0): number {
	const from = Math.floor(start);
	let mean = 0;
	for (let i = from; i < x.length; i++) mean += x[i];
	mean /= x.length - from;
	let first = -1;
	let last = -1;
	let count = 0;
	for (let i = from + 1; i < x.length; i++) {
		const a = x[i - 1] - mean;
		const b = x[i] - mean;
		if (a <= 0 && b > 0) {
			const t = i - 1 + -a / (b - a);
			if (first < 0) first = t;
			last = t;
			count++;
		}
	}
	return ((count - 1) * rate) / (last - first);
}

export function peak(x: Float32Array, from = 0): number {
	let m = 0;
	for (let i = from; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
	return m;
}

/** level of the audible part of a segment: the root mean square after removing its DC component */
export function rms(x: Float32Array, from = 0, to = x.length): number {
	const n = Math.max(1, to - from);
	let mean = 0;
	for (let i = from; i < to; i++) mean += x[i];
	mean /= n;
	let s = 0;
	for (let i = from; i < to; i++) s += (x[i] - mean) * (x[i] - mean);
	return Math.sqrt(s / n);
}

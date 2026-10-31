// Usage: npx tsx tools/tempo.ts <mono 16-bit wav> [from seconds] [to seconds]
// Estimates the tempo (onset-envelope autocorrelation) and the pitch-class profile of a reference
import { readFileSync } from 'node:fs';

const [path, fromArg, toArg] = process.argv.slice(2);
const b = readFileSync(path);
const rate = b.readUInt32LE(24);
const first = b.indexOf('data') + 8;
const count = (b.length - first) >> 1;
const from = Math.round(Number(fromArg ?? 0) * rate);
const to = Math.min(count, Math.round(Number(toArg ?? count / rate) * rate));
const x = new Float32Array(to - from);
for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(first + 2 * (from + i)) / 32768;

// onset strength: positive change of the energy in 10 ms frames
const hop = Math.round(rate * 0.01);
const frames = Math.floor(x.length / hop);
const energy = new Float64Array(frames);
for (let f = 0; f < frames; f++) {
	let e = 0;
	for (let i = 0; i < hop; i++) e += x[f * hop + i] ** 2;
	energy[f] = Math.log(1e-6 + e / hop);
}
const onset = new Float64Array(frames);
for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
const mean = onset.reduce((a, c) => a + c, 0) / frames;
for (let f = 0; f < frames; f++) onset[f] -= mean;

const scores: { bpm: number; score: number }[] = [];
for (let bpm = 70; bpm <= 200; bpm += 0.25) {
	const lag = 6000 / bpm; // in 10 ms frames
	let s = 0;
	for (let m = 1; m <= 4; m++) {
		const l = lag * m;
		for (let f = 0; f + l + 1 < frames; f++) {
			const i = Math.floor(f + l);
			const w = f + l - i;
			s += onset[f] * (onset[i] * (1 - w) + onset[i + 1] * w);
		}
	}
	scores.push({ bpm, score: s });
}
scores.sort((p, q) => q.score - p.score);
const top: number[] = [];
for (const c of scores) if (top.every((t) => Math.abs(t - c.bpm) > 3) && top.length < 4) top.push(c.bpm);
console.log('tempo candidates (BPM):', top.map((t) => t.toFixed(2)).join(', '));

// pitch-class profile from a Goertzel bank over C2..B6
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const profile = new Float64Array(12);
const step = Math.round(rate * 0.5);
const n = 8192;
for (let start = 0; start + n < x.length; start += step) {
	for (let midi = 36; midi < 96; midi++) {
		const w = (2 * Math.PI * 440 * 2 ** ((midi - 69) / 12)) / rate;
		const cw = 2 * Math.cos(w);
		let s1 = 0;
		let s2 = 0;
		for (let i = 0; i < n; i++) {
			const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
			const s0 = x[start + i] * h + cw * s1 - s2;
			s2 = s1;
			s1 = s0;
		}
		profile[midi % 12] += Math.sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2);
	}
}
const total = profile.reduce((a, c) => a + c, 0);
console.log('pitch classes:', names.map((nm, i) => `${nm} ${((100 * profile[i]) / total).toFixed(1)}%`).join('  '));

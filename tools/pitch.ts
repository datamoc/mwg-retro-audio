// Usage: npx tsx tools/pitch.ts <mono 16-bit wav> <from s> <to s> [lowHz] [highHz]
// Tracks the dominant pitch (normalised autocorrelation, 40 ms frames every 20 ms) and prints runs of equal notes
import { readFileSync } from 'node:fs';

const [path, fromArg, toArg, lowArg, highArg] = process.argv.slice(2);
const b = readFileSync(path);
const rate = b.readUInt32LE(24);
const first = b.indexOf('data') + 8;
const from = Math.round(Number(fromArg) * rate);
const to = Math.min((b.length - first) >> 1, Math.round(Number(toArg) * rate));
const x = new Float32Array(to - from);
for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(first + 2 * (from + i)) / 32768;

const low = Number(lowArg ?? 60);
const high = Number(highArg ?? 700);
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const frame = Math.round(rate * 0.04);
const hop = Math.round(rate * 0.02);
const minLag = Math.floor(rate / high);
const maxLag = Math.ceil(rate / low);

const notes: (number | null)[] = [];
for (let start = 0; start + frame + maxLag < x.length; start += hop) {
	let e0 = 0;
	for (let i = 0; i < frame; i++) e0 += x[start + i] ** 2;
	if (e0 / frame < 1e-5) {
		notes.push(null);
		continue;
	}
	let best = 0;
	let bestScore = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let dot = 0;
		let e1 = 0;
		for (let i = 0; i < frame; i++) {
			dot += x[start + i] * x[start + i + lag];
			e1 += x[start + i + lag] ** 2;
		}
		const score = dot / Math.sqrt(e0 * e1 + 1e-12);
		if (score > bestScore) {
			bestScore = score;
			best = lag;
		}
	}
	notes.push(bestScore > 0.8 ? Math.round(69 + 12 * Math.log2(rate / best / 440)) : null);
}

let runStart = 0;
for (let i = 1; i <= notes.length; i++) {
	if (i === notes.length || notes[i] !== notes[runStart]) {
		const n = notes[runStart];
		const length = (i - runStart) * 0.02;
		if (n !== null && length >= 0.06)
			console.log(
				`${(Number(fromArg) + runStart * 0.02).toFixed(2).padStart(7)} s  ${(names[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1)).padEnd(4)} ${length.toFixed(2)} s`,
			);
		runStart = i;
	}
}

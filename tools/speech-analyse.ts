// Usage: npx tsx tools/speech-analyse.ts <mono 16-bit wav> [seconds] [window seconds]
// Prints loudness, spectral centroid and dominant frequency per window of a reference decoded with ffmpeg
import { readFileSync } from 'node:fs';

function readWav(path: string): { rate: number; samples: Float32Array } {
	const b = readFileSync(path);
	let pos = 12;
	let rate = 0;
	while (pos + 8 <= b.length) {
		const id = b.toString('ascii', pos, pos + 4);
		const size = b.readUInt32LE(pos + 4);
		if (id === 'fmt ') rate = b.readUInt32LE(pos + 12);
		if (id === 'data') {
			const n = Math.min(size, b.length - pos - 8) >> 1;
			const samples = new Float32Array(n);
			for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(pos + 8 + 2 * i) / 32768;
			return { rate, samples };
		}
		pos += 8 + size + (size & 1);
	}
	throw new Error('no data chunk');
}

/** in-place radix-2 FFT */
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
		for (let i = 0; i < n; i += len)
			for (let k = 0; k < len / 2; k++) {
				const wr = Math.cos(ang * k);
				const wi = Math.sin(ang * k);
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

const [path, secondsArg, windowArg] = process.argv.slice(2);
const { rate, samples } = readWav(path);
const total = Math.min(samples.length, Math.round(Number(secondsArg ?? 30) * rate));
const hop = Math.round(Number(windowArg ?? 0.5) * rate);
let size = 1;
while (size < hop) size <<= 1;
console.log(`rate ${rate} Hz, ${(total / rate).toFixed(2)} s`);
for (let start = 0; start + hop <= total; start += hop) {
	const re = new Float64Array(size);
	const im = new Float64Array(size);
	let energy = 0;
	for (let i = 0; i < hop; i++) {
		const s = samples[start + i];
		energy += s * s;
		re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / hop));
	}
	fft(re, im);
	let sum = 0;
	let weighted = 0;
	let peak = 1;
	let peakMag = 0;
	for (let k = 1; k < size / 2; k++) {
		const m = Math.hypot(re[k], im[k]);
		sum += m;
		weighted += m * k;
		if (m > peakMag) {
			peakMag = m;
			peak = k;
		}
	}
	const hz = (k: number): number => (k * rate) / size;
	console.log(
		`${(start / rate).toFixed(1).padStart(5)} s  rms ${Math.sqrt(energy / hop).toFixed(3)}  centroid ${hz(
			weighted / Math.max(sum, 1e-9),
		)
			.toFixed(0)
			.padStart(5)} Hz  peak ${hz(peak).toFixed(0).padStart(5)} Hz`,
	);
}

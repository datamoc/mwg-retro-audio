// Usage: npx tsx tools/voice-tilt.ts
// Measures how bright the formant voice is: energy at 2-5 kHz relative to energy below 1 kHz, for a few sung vowels
import { fft } from '../src/driver/analysis.ts';
import { sing } from '../src/speech/index.ts';

const RATE = 44100;
function bandEnergy(x: Float32Array, low: number, high: number): number {
	const size = 16384;
	let total = 0;
	for (let start = RATE >> 2; start + size <= x.length; start += size) {
		const re = new Float64Array(size);
		const im = new Float64Array(size);
		for (let i = 0; i < size; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
		fft(re, im);
		for (let k = Math.floor((low * size) / RATE); k < Math.floor((high * size) / RATE); k++)
			total += re[k] ** 2 + im[k] ** 2;
	}
	return total;
}
for (const vowel of ['a', 'e', 'i', 'o', 'u']) {
	for (const [name, note] of [
		['A3 (220 Hz)', 57],
		['C5 (523 Hz)', 72],
	] as const) {
		const x = sing([{ phonemes: vowel, note, duration: 1.2 }], { sampleRate: RATE, source: 'glottal' });
		const ratio = 10 * Math.log10(bandEnergy(x, 2000, 5000) / bandEnergy(x, 80, 1000));
		console.log(`vowel ${vowel} ${name}: 2-5 kHz vs below 1 kHz ${ratio.toFixed(1)} dB`);
	}
}

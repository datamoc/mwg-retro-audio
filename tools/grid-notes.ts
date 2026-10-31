// Usage: npx tsx tools/grid-notes.ts <mono 16-bit wav> <bpm> <from s> <bars> [lowMidi] [highMidi]
// Strongest pitch per 16th note on a tempo grid (Goertzel bank), printed as one line of notes per bar
import { readFileSync } from 'node:fs';

const [path, bpmArg, fromArg, barsArg, lowArg, highArg] = process.argv.slice(2);
const b = readFileSync(path);
const rate = b.readUInt32LE(24);
const first = b.indexOf('data') + 8;
const n = (b.length - first) >> 1;
const x = new Float32Array(n);
for (let i = 0; i < n; i++) x[i] = b.readInt16LE(first + 2 * i) / 32768;

const sixteenth = 60 / Number(bpmArg) / 4;
const low = Number(lowArg ?? 36);
const high = Number(highArg ?? 84);
const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const len = Math.min(4096, Math.round(sixteenth * rate));

for (let bar = 0; bar < Number(barsArg); bar++) {
	const cells: string[] = [];
	for (let k = 0; k < 16; k++) {
		const start = Math.round((Number(fromArg) + (bar * 16 + k) * sixteenth) * rate);
		let bestMidi = 0;
		let best = 0;
		let total = 0;
		for (let midi = low; midi <= high; midi++) {
			const w = (2 * Math.PI * 440 * 2 ** ((midi - 69) / 12)) / rate;
			const cw = 2 * Math.cos(w);
			let s1 = 0;
			let s2 = 0;
			for (let i = 0; i < len; i++) {
				const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
				const s0 = x[start + i] * h + cw * s1 - s2;
				s2 = s1;
				s1 = s0;
			}
			const m = Math.sqrt(s1 * s1 + s2 * s2 - cw * s1 * s2);
			total += m;
			if (m > best) {
				best = m;
				bestMidi = midi;
			}
		}
		const label = best / total > 0.08 ? names[bestMidi % 12] + (Math.floor(bestMidi / 12) - 1) : '.';
		cells.push(label.padEnd(4));
	}
	console.log(`bar ${String(bar + 1).padStart(2)}: ${cells.join('')}`);
}

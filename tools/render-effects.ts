// Usage: npx tsx tools/render-effects.ts [outputDir]
// Renders one short phrase through every built-in retro effect preset so they can be auditioned side by side:
// square-wave arpeggio, a noise burst and a bright 6 kHz tone expose low-pass, sample-and-hold and bitcrush.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '../src/driver/Renderer.ts';
import { processRetroEffects, retroEffectNames } from '../src/effects/index.ts';

const RATE = 44100;
const outputDir = process.argv[2] ?? 'demo-output/effects';
mkdirSync(outputDir, { recursive: true });

/** the same phrase for every preset: deterministic, bright and short */
function source(): { left: Float32Array; right: Float32Array } {
	const frames = Math.floor(RATE * 2.4);
	const left = new Float32Array(frames);
	const right = new Float32Array(frames);
	const notes = [261.63, 329.63, 392, 523.25, 392, 329.63];
	let phase = 0;
	let noise = 0x12345678;
	for (let i = 0; i < frames; i++) {
		const t = i / RATE;
		const step = Math.floor(t / 0.2);
		const frequency = notes[step % notes.length];
		phase += frequency / RATE;
		if (phase >= 1) phase -= 1;
		let value = phase < 0.5 ? 1 : -1;
		if (t > 1.2) value = 0.7 * value + 0.3 * (Math.sin(2 * Math.PI * 6000 * t) > 0 ? 1 : -1);
		noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
		if (t > 0.4 && t < 0.5) value = 0.6 * ((noise / 0xffffffff) * 2 - 1);
		const gate = Math.min(1, (0.2 - (t % 0.2)) / 0.02);
		left[i] = value * gate * 0.35;
		right[i] = value * gate * 0.35;
	}
	return { left, right };
}

const base = source();
for (const name of retroEffectNames()) {
	const left = Float32Array.from(base.left);
	const right = Float32Array.from(base.right);
	const applied = processRetroEffects(left, right, RATE, name);
	const file = join(outputDir, `effect-${name}.wav`);
	writeFileSync(file, encodeWav(left, right, RATE));
	console.log(`${file}: ${applied.stages.join(' -> ') || 'dry'}`);
}

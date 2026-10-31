// Usage: npx tsx tools/style-reference.ts <reference.wav> <from s> <to s> <style id> [seed]
// Compares the tone colour (band spectrum) and tempo of a reference recording with a generated cue of a style, and
// with the cues of the other styles. Only statistics of the reference are used, never its notes
import { readFileSync } from 'node:fs';
import { checkCue, composeCue, STYLES } from '../src/compose/index.ts';
import { bandShapeDistance, estimateTempo, meanBandShape } from '../src/driver/analysis.ts';

const [path, fromArg, toArg, styleId, seed = 'ref'] = process.argv.slice(2);
const b = readFileSync(path);
const rate = b.readUInt32LE(24);
const first = b.indexOf('data') + 8;
const from = Math.round(Number(fromArg) * rate);
const to = Math.min((b.length - first) >> 1, Math.round(Number(toArg) * rate));
const reference = new Float32Array(to - from);
for (let i = 0; i < reference.length; i++) reference[i] = b.readInt16LE(first + 2 * (from + i)) / 32768;

const referenceShape = meanBandShape(reference, rate);
console.log(
	`reference ${path}: tempo candidates ${estimateTempo(reference, rate, 60, 200)
		.map((t) => t.toFixed(1))
		.join(', ')} BPM`,
);
const rows = Object.keys(STYLES).map((id) => {
	const cue = composeCue({ style: id, seed, duration: 30, sampleRate: rate });
	const mono = Float32Array.from(cue.left, (l, i) => 0.5 * (l + cue.right[i]));
	return { id, distance: bandShapeDistance(meanBandShape(mono, rate), referenceShape), check: checkCue(cue) };
});
for (const r of rows.sort((p, q) => p.distance - q.distance))
	console.log(
		`${r.id.padEnd(22)} band shape distance ${r.distance.toFixed(3)}${r.id === styleId ? '   <-- the style under test' : ''}`,
	);

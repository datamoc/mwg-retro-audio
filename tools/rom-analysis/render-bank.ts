// Offline helper of the closeness measurement: renders every recipe of a bank at the root pitch of each reference
// attack, so that the Python side can compare them with the recording. Usage:
//   node --import tsx tools/rom-analysis/render-bank.ts <bank.json | -> <f0s.json> <out.bin> <out.json>
// `-` takes the bank compiled into the package (`D50_ATTACKS`).
import { readFileSync, writeFileSync } from 'node:fs';
import { D50_ATTACKS, renderAttackRecipe, type D50Attack } from '../../src/chips/historical.ts';

const [bankPath, f0Path, outBin, outIdx] = process.argv.slice(2);
const bank: readonly D50Attack[] = bankPath === '-' ? D50_ATTACKS : JSON.parse(readFileSync(bankPath, 'utf8'));
const f0s: number[] = JSON.parse(readFileSync(f0Path, 'utf8'));
const RATE = Number(process.env.MW_RATE ?? 32000);
const chunks: Float32Array[] = [];
const index: { seg: number; recipe: number; offset: number; length: number }[] = [];
let offset = 0;
f0s.forEach((f0, seg) =>
	bank.forEach((recipe, r) => {
		const w = renderAttackRecipe(recipe, RATE, f0);
		chunks.push(w);
		index.push({ seg, recipe: r, offset, length: w.length });
		offset += w.length;
	}),
);
const all = new Float32Array(offset);
let o = 0;
for (const c of chunks) {
	all.set(c, o);
	o += c.length;
}
writeFileSync(outBin, Buffer.from(all.buffer));
writeFileSync(outIdx, JSON.stringify(index));

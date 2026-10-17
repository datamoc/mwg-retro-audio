/** Scan the clock origin and report exactness inside the active (non silent) part of the reference. */
import { readFileSync } from 'node:fs';
import { readTrace } from '../src/trace.ts';
import { renderTrace } from '../src/render.ts';
const [tracePath, refPath, from = '1500000', len = '400000', lo = '0', hi = '40'] = process.argv.slice(2);
const refBuf = readFileSync(refPath);
const ref = new Int16Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength >> 1);
const trace = await readTrace(tracePath);
const f = Number(from), n = Number(len);
let rms = 0; for (let i = f; i < f + n; i++) rms += ref[i] * ref[i];
console.log('reference window rms', Math.sqrt(rms / n).toFixed(1));
const rows: [number, number, number, number][] = [];
for (let o = Number(lo); o <= Number(hi); o++) {
	const out = renderTrace(trace, { origin: o });
	let exact = 0, maxd = 0, sad = 0;
	for (let i = f; i < f + n; i++) { const d = Math.abs(out[i] - ref[i]); if (d === 0) exact++; if (d > maxd) maxd = d; sad += d; }
	rows.push([o, exact / n, maxd, sad / n]);
}
rows.sort((a, b) => b[1] - a[1]);
for (const r of rows.slice(0, 8)) console.log(`origin ${r[0]}: exact ${(r[1] * 100).toFixed(2)}%  max|d| ${r[2]}  mean|d| ${r[3].toFixed(2)}`);

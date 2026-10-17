/**
 * Compare the TypeScript synthesizer with the audio Hatari actually produced.
 *   node test/validate.ts <trace.txt> <reference.s16le (mono)> [origin ...]
 * The reference comes from the AVI recorded by Hatari (which stores AudioMixBuffer verbatim):
 *   ffmpeg -i rec.avi -vn -af "pan=mono|c0=c0" -f s16le -acodec pcm_s16le ref.s16le
 */
import { readFileSync } from 'node:fs';
import { readTrace } from '../src/trace.ts';
import { renderTrace } from '../src/render.ts';
import { HATARI_TRACE_ORIGIN } from '../src/trace.ts';

const [tracePath, refPath, ...origins] = process.argv.slice(2);
const refBuf = readFileSync(refPath);
const ref = new Int16Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength >> 1);
const trace = await readTrace(tracePath);
const lastVbl = trace.frameStart.length - 1;
console.log(`trace: ${trace.events.length} YM events, ${lastVbl} VBL, reference ${ref.length} samples (${(ref.length / 44100).toFixed(2)} s)`);

function compare(out: Int16Array, shift: number, from: number, len: number) {
	// out[shift + i] against ref[i]
	let exact = 0, n = 0, maxd = 0, sumd = 0;
	let first = -1;
	for (let i = from; i < from + len && shift + i < out.length && i < ref.length; i++) {
		const d = Math.abs(out[shift + i] - ref[i]);
		if (d === 0) exact++; else if (first < 0) first = i;
		if (d > maxd) maxd = d;
		sumd += d; n++;
	}
	return { n, exact, frac: exact / Math.max(n, 1), maxd, meand: sumd / Math.max(n, 1), first };
}

function bestShift(out: Int16Array, from: number, len: number, range: number) {
	let best = { shift: 0, sad: Infinity };
	for (let s = 0; s <= range; s++) {
		let sad = 0;
		for (let i = from; i < from + len; i++) sad += Math.abs(out[s + i] - ref[i]);
		if (sad < best.sad) best = { shift: s, sad };
	}
	return best;
}

for (const o of (origins.length ? origins.map(Number) : [HATARI_TRACE_ORIGIN])) {
	const t0 = Date.now();
	const out = renderTrace(trace, { origin: o });
	const mid = Math.min(ref.length >> 1, 400000);
	const bs = bestShift(out, mid, 4000, 6000);
	const cmp = compare(out, bs.shift, 0, ref.length);
	const late = compare(out, bs.shift, mid, 200000);
	console.log(`origin ${o}: synth ${out.length} samples in ${Date.now() - t0} ms | best shift ${bs.shift} | ` +
		`exact ${(cmp.frac * 100).toFixed(3)}% (${cmp.exact}/${cmp.n}) max|d| ${cmp.maxd} mean|d| ${cmp.meand.toFixed(2)} first mismatch @${cmp.first} | ` +
		`window@${mid}: exact ${(late.frac * 100).toFixed(2)}% max|d| ${late.maxd}`);
}

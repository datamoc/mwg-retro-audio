import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { HatariYm, renderTrace, renderRegisterFrames, HATARI_TRACE_ORIGIN } from '../src/index.ts';
import type { TraceData } from '../src/index.ts';

function loadFixture(name: string): { trace: TraceData; expected: { samples: number; sha256: string } } {
	const raw = JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/${name}.events.json.gz`, import.meta.url))).toString());
	const trace: TraceData = {
		frameStart: raw.frameStart,
		frameLength: raw.frameStart.map((s: number, i: number) => (i ? s - raw.frameStart[i - 1] : 0)),
		events: raw.events.map((e: number[]) => ({ clock: e[0], kind: e[1] ? 'r' : 'w', reg: e[2], value: e[3], vbl: e[4], instr: e[5] })),
	};
	const expected = JSON.parse(readFileSync(new URL(`./fixtures/${name}.expected.json`, import.meta.url), 'utf8'));
	return { trace, expected };
}

const sha256 = (pcm: Int16Array): string =>
	createHash('sha256').update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');

// The reference hashes are those of the PCM audio recorded by Hatari 2.5.0 itself (not of this code's output):
// passing means the TypeScript port reproduces Hatari's output sample for sample.
for (const name of ['calib2', 'tune4']) {
	test(`bit-exact against Hatari's own audio: ${name}`, () => {
		const { trace, expected } = loadFixture(name);
		const pcm = renderTrace(trace);
		assert.equal(pcm.length, expected.samples, 'same number of samples as Hatari');
		assert.equal(sha256(pcm), expected.sha256, 'every sample identical to Hatari output');
	});
}

test('output does not depend on how Sound_Update calls are interleaved', () => {
	const { trace } = loadFixture('calib2');
	const run = (every: number): Int16Array => {
		const ym = new HatariYm();
		ym.reset(0);
		let vbl = 0, lastExtra = 0;
		for (const e of trace.events) {
			if (e.vbl > 1670) break;
			while (vbl < e.vbl) { vbl++; ym.update(HATARI_TRACE_ORIGIN + trace.frameStart[vbl]); }
			const c = HATARI_TRACE_ORIGIN + e.clock;
			if (every) while (lastExtra + every < c - 5) { lastExtra += every; ym.update(lastExtra); }
			if (e.kind === 'r') ym.psgReset(); else ym.writeData(c, e.reg, e.value);
		}
		return ym.takeSamples();
	};
	const a = run(0), b = run(1237);
	assert.equal(a.length, b.length);
	assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('clone() gives an independent copy that evolves identically', () => {
	const ym = new HatariYm();
	ym.reset(0);
	ym.writeData(1000, 0, 100); ym.writeData(1100, 8, 15); ym.writeData(1200, 7, 0x3e);
	ym.update(100000);
	ym.takeSamples();                                        // clone() does not copy pending output
	const copy = ym.clone();
	ym.writeData(120000, 8, 3); copy.writeData(120000, 8, 3);
	ym.update(400000); copy.update(400000);
	const a = ym.takeSamples(), b = copy.takeSamples();
	assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});

test('silence in, silence out; a tone has the expected pitch', () => {
	const quiet = new HatariYm();
	quiet.reset(0);
	quiet.update(8021247);                                   // 1 s of CPU time
	const q = quiet.takeSamples();
	assert.ok(q.length > 44000 && q.length <= 44100);
	assert.ok(q.every(v => v === 0));

	const ym = new HatariYm();
	ym.reset(0);
	// voice A, period 568 (about 220 Hz on an ST), full volume, tone on, noise off
	ym.writeData(1000, 0, 568 & 0xff); ym.writeData(1100, 1, 568 >> 8); ym.writeData(1200, 8, 15); ym.writeData(1300, 7, 0x3e);
	ym.update(8021247 * 2);
	const s = ym.takeSamples();
	// count rising zero crossings in the last second of audio
	let crossings = 0;
	for (let i = 44100 + 1; i < s.length; i++) if (s[i - 1] <= 0 && s[i] > 0) crossings++;
	const expected = 2005311 / (16 * 568);                  // YM clock / (16 * period)
	assert.ok(Math.abs(crossings - expected) < 3, `${crossings} crossings, expected about ${expected.toFixed(1)}`);
});

test('register-frame helper renders a driver-style register stream', () => {
	const frame = [56, 2, 56, 2, 0, 0, 0, 0xf8 & ~1, 15, 0, 0];
	const frames = Array.from({ length: 246 }, () => frame);   // one second of identical driver ticks
	const pcm = renderRegisterFrames(frames);
	assert.ok(pcm.length > 40000);
	assert.ok(pcm.some(v => v !== 0));
});

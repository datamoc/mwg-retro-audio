import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, loadFile, parseSmf, xmiToSmf, isXmi } from '../src/formats/index.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { peak, RATE } from './util.ts';

/** strongest frequency in [lo, hi] Hz by a Goertzel scan (FM timbres have harmonics: zero crossings would mislead) */
function dominant(x: Float32Array, lo: number, hi: number): number {
	let best = lo;
	let bestPower = -1;
	for (let f = lo; f <= hi; f += 1) {
		const w = (2 * Math.PI * f) / RATE;
		let s1 = 0;
		let s2 = 0;
		for (let i = 0; i < x.length; i++) {
			const s0 = x[i] + 2 * Math.cos(w) * s1 - s2;
			s2 = s1;
			s1 = s0;
		}
		const p = s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2;
		if (p > bestPower) {
			bestPower = p;
			best = f;
		}
	}
	return best;
}

const smf = (track: number[], division = 96): Uint8Array =>
	Uint8Array.from([
		0x4d,
		0x54,
		0x68,
		0x64,
		0,
		0,
		0,
		6,
		0,
		0,
		0,
		1,
		division >> 8,
		division & 255,
		0x4d,
		0x54,
		0x72,
		0x6b,
		0,
		0,
		0,
		track.length,
		...track,
	]);

// tempo 500000 us per beat (120 bpm), 96 ticks per beat: 96 ticks = 0.5 s
const A4_HALF_SECOND = [
	0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xc0, 0, 0, 0x90, 69, 100, 96, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
];

test('Standard MIDI File: tempo map, note events and the generic OPL sound set at the right pitch', () => {
	const bytes = smf(A4_HALF_SECOND);
	assert.equal(detectFormat(bytes), 'midi');
	const song = parseSmf(bytes);
	const on = song.events.find((e) => e.status === 0x90)!;
	const off = song.events.find((e) => e.status === 0x80)!;
	assert.ok(on.time === 0 && Math.abs(off.time - 0.5) < 1e-9, `off at ${off.time}`);
	const out = renderPlayer(loadFile(bytes, { sampleRate: RATE }), { maxSeconds: 5 });
	const f0 = dominant(out.left.subarray(3000, Math.floor(RATE * 0.45)), 300, 1500);
	assert.ok(Math.abs(f0 / 440 - Math.round(f0 / 440)) * 440 < 3, `dominant ${f0} Hz is not a harmonic of 440`);
	assert.ok(out.ended && peak(out.left) > 0.05);
	// a faster tempo shortens the notes
	const fast = parseSmf(smf([0, 0xff, 0x51, 3, 0x03, 0xd0, 0x90, ...A4_HALF_SECOND.slice(7)]));
	assert.ok(fast.events.find((e) => e.status === 0x80)!.time < 0.3);
});

test('XMI: note durations become note-offs, the 120 Hz clock keeps real time', () => {
	const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
	const be32 = (n: number): number[] => [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
	// events: program 0, note on A4 with a duration of 60 ticks (0.5 s at 120 Hz), end of track
	const evnt = [0xc0, 0, 0x90, 69, 100, 60, 0xff, 0x2f, 0];
	const body = [
		...ascii('XDIRINFO'),
		...be32(2),
		1,
		0,
		...ascii('CAT '),
		...be32(0),
		...ascii('XMID'),
		...ascii('FORM'),
		...be32(0),
		...ascii('XMID'),
		...ascii('EVNT'),
		...be32(evnt.length),
		...evnt,
	];
	const xmi = Uint8Array.from([...ascii('FORM'), ...be32(body.length + 4), ...ascii('XDIR'), ...body.slice(0)]);
	assert.ok(isXmi(xmi));
	const song = parseSmf(xmiToSmf(xmi));
	const off = song.events.find((e) => e.status === 0x80)!;
	assert.ok(Math.abs(off.time - 0.5) < 1e-6, `note-off at ${off.time}`);
	assert.equal(detectFormat(xmi), 'midi');
	const out = renderPlayer(loadFile(xmi, { sampleRate: RATE }), { maxSeconds: 5 });
	assert.ok(peak(out.left) > 0.05);
});

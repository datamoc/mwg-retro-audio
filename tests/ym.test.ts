import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isYm, loadYm, parseYm } from '../src/formats/ym.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { Region } from '../src/region.ts';
import { frequency, peak, rms, RATE } from './util.ts';
import { buildYm } from './ymfile.ts';

const toneRegs = (period: number, vol = 15): number[] => {
	const r = new Array<number>(16).fill(0);
	r[0] = period & 255;
	r[1] = period >> 8;
	r[7] = 0b111110;
	r[8] = vol;
	return r;
};

test('YM6 header, strings and interleaved / frame-major data are parsed', () => {
	for (const interleaved of [true, false]) {
		const bytes = buildYm({ frames: 10, regs: (f) => toneRegs(100 + f), interleaved, title: 'Song', loop: 3 });
		assert.ok(isYm(bytes));
		const s = parseYm(bytes);
		assert.equal(s.title, 'Song');
		assert.equal(s.frames, 10);
		assert.equal(s.loopFrame, 3);
		assert.equal(s.clock, 2_000_000);
		assert.equal(s.data[0 * 10 + 4], 104, 'register 0 of frame 4');
	}
	assert.throws(() => parseYm(new Uint8Array([1, 2, 3, 4, 5])));
});

test('YM2!/YM3! register dumps play at 50 Hz with a 2 MHz clock', () => {
	const frames = 50;
	const data = new Uint8Array(4 + 14 * frames);
	data.set([89, 77, 51, 33]); // "YM3!"
	for (let f = 0; f < frames; f++) {
		const r = toneRegs(568, 15);
		for (let i = 0; i < 14; i++) data[4 + i * frames + f] = r[i];
	}
	const player = loadYm(data, { sampleRate: RATE });
	assert.equal(player.info.region, Region.PAL);
	const out = renderPlayer(player, { maxSeconds: 5 });
	assert.ok(out.ended);
	assert.ok(Math.abs(out.duration - 1) < 0.01, `duration ${out.duration}`);
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 2_000_000 / (16 * 568)) < 0.2);
});

test('the frame rate of the file sets the tempo and the region (NTSC 60 Hz)', () => {
	const bytes = buildYm({ frames: 120, rate: 60, regs: () => toneRegs(300) });
	const player = loadYm(bytes, { sampleRate: RATE });
	assert.equal(player.info.region, Region.NTSC);
	const out = renderPlayer(player, { maxSeconds: 10 });
	assert.ok(Math.abs(out.duration - 2) < 0.01, `duration ${out.duration}`);
});

test('frame-accurate register changes: a note change happens exactly at the frame boundary', () => {
	const bytes = buildYm({ frames: 20, regs: (f) => toneRegs(f < 10 ? 400 : 200) });
	const out = renderPlayer(loadYm(bytes, { sampleRate: RATE }), { maxSeconds: 5 });
	const half = Math.floor(RATE * 0.2);
	const a = frequency(out.left.subarray(2000, half - 100), RATE);
	const b = frequency(out.left.subarray(half + 100, RATE * 0.4 - 100), RATE);
	assert.ok(Math.abs(b / a - 2) < 0.03, `${a} -> ${b}`);
});

test('looping YM files continue past the end and stop without the loop option', () => {
	const bytes = buildYm({ frames: 25, regs: () => toneRegs(200), loop: 5 });
	const looped = renderPlayer(loadYm(bytes, { sampleRate: RATE, loop: true }), { maxSeconds: 3 });
	assert.ok(!looped.ended && Math.abs(looped.duration - 3) < 0.01);
	const once = renderPlayer(loadYm(bytes, { sampleRate: RATE }), { maxSeconds: 3 });
	assert.ok(once.ended && once.duration < 0.6);
});

test('SID-voice effect modulates the volume at the timer rate', () => {
	// effect on voice A (code 0x10 in R1 high nibble), MFP prediv 4 (bits 5-7 of R6 = 1), count 20 -> 30720 Hz
	const regs = (): number[] => {
		const r = toneRegs(100, 15);
		r[1] |= 0x10; // code: voice A, SID voice
		r[6] = 0x20; // prediv index 1 (= 4)
		r[14] = 80; // timer count: 2457600 / (4 * 80) = 7680 Hz
		return r;
	};
	const fx = renderPlayer(loadYm(buildYm({ frames: 25, regs }), { sampleRate: RATE }), { maxSeconds: 2 });
	const plain = renderPlayer(loadYm(buildYm({ frames: 25, regs: () => toneRegs(100, 15) }), { sampleRate: RATE }), {
		maxSeconds: 2,
	});
	assert.notDeepEqual(fx.left, plain.left);
	// the volume flips to zero half the time, so the average level is lower than with the steady tone
	assert.ok(rms(fx.left, 2000) < rms(plain.left, 2000) * 0.95, `${rms(fx.left, 2000)} vs ${rms(plain.left, 2000)}`);
});

test('digidrum effect plays the sample through the volume register', () => {
	const drum = new Uint8Array(200).map((_, i) => (i % 2 ? 0xf0 : 0x10)); // loud square at the timer rate / 2
	const regs = (f: number): number[] => {
		const r = new Array<number>(16).fill(0);
		r[7] = 0b111111; // everything off
		if (f === 2) {
			r[1] = 0x50; // voice A, digidrum
			r[6] = 0x20; // prediv 4
			r[14] = 50; // 2457600 / 200 = 12288 Hz
			r[8] = 0; // drum number 0
		}
		return r;
	};
	const silent = renderPlayer(
		loadYm(buildYm({ frames: 10, regs: () => regs(0), drums: [drum] }), { sampleRate: RATE }),
		{ maxSeconds: 1 },
	);
	const drums = renderPlayer(loadYm(buildYm({ frames: 10, regs, drums: [drum] }), { sampleRate: RATE }), {
		maxSeconds: 1,
	});
	assert.ok(peak(drums.left) > peak(silent.left) + 0.05, `${peak(drums.left)} vs ${peak(silent.left)}`);
});

test('sync-buzzer effect restarts the envelope at the timer rate (pitch of the buzz follows the timer)', () => {
	const regs = (): number[] => {
		const r = new Array<number>(16).fill(0);
		r[7] = 0b111111;
		r[8] = 0x10; // envelope on voice A
		r[11] = 1; // fastest envelope: one 32 step ramp lasts about 130 us, shorter than a timer period
		r[12] = 0;
		r[13] = 0; // \___ decaying
		r[1] = 0xd0; // voice A (0x10) + sync buzzer (0xc0)
		r[6] = 0x20;
		r[14] = 100; // 2457600 / 400 = 6144 Hz
		return r;
	};
	const out = renderPlayer(loadYm(buildYm({ frames: 25, regs }), { sampleRate: RATE }), { maxSeconds: 1 });
	const buzz = frequency(out.left, RATE, 2000);
	assert.ok(Math.abs(buzz - 6144) < 400, `buzz ${buzz} Hz`);
});

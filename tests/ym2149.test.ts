import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ym2149 } from '../src/chips/Ym2149.ts';

const RATE = 44100;

function renderMono(chip: Ym2149, seconds: number): Float32Array {
	const n = Math.floor(seconds * RATE);
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	chip.render(l, r, 0, n);
	return l;
}

/** frequency from the time between the first and the last rising crossing (linear interpolation): precise to a few ppm */
function frequency(x: Float32Array, from = 0): number {
	let mean = 0;
	for (let i = from; i < x.length; i++) mean += x[i];
	mean /= x.length - from;
	let first = -1;
	let last = -1;
	let count = 0;
	for (let i = from + 1; i < x.length; i++) {
		const a = x[i - 1] - mean;
		const b = x[i] - mean;
		if (a <= 0 && b > 0) {
			const t = i - 1 + -a / (b - a);
			if (first < 0) first = t;
			last = t;
			count++;
		}
	}
	return ((count - 1) * RATE) / (last - first);
}

function toneOnA(chip: Ym2149, period: number, volume: number): void {
	chip.write(0, period & 255);
	chip.write(1, period >> 8);
	chip.write(8, volume);
	chip.write(7, 0b111110); // tone A only
}

test('tone frequency is clock / (16 * period), as on the real chip', () => {
	const chip = new Ym2149({ sampleRate: RATE, clock: 2_000_000 });
	toneOnA(chip, 568, 15);
	const out = renderMono(chip, 2);
	const hz = frequency(out, RATE);
	const expected = 2_000_000 / (16 * 568);
	assert.ok(Math.abs(hz - expected) < 0.05, `${hz} Hz, expected ${expected.toFixed(2)}`);
});

test('the clock moves the pitch: Atari ST NTSC clock is 0.13 % lower than PAL', () => {
	const hzOf = (clock: number): number => {
		const chip = new Ym2149({ sampleRate: RATE, clock });
		toneOnA(chip, 568, 15);
		return frequency(renderMono(chip, 3), RATE);
	};
	const ratio = hzOf(2_002_650) / hzOf(2_005_311);
	assert.ok(Math.abs(ratio - 2_002_650 / 2_005_311) < 0.00005, `ratio ${ratio}`);
});

test('period 0 behaves like period 1', () => {
	const a = new Ym2149({ sampleRate: RATE });
	const b = new Ym2149({ sampleRate: RATE });
	toneOnA(a, 0, 15);
	toneOnA(b, 1, 15);
	assert.deepEqual(renderMono(a, 0.05), renderMono(b, 0.05));
});

test('volume follows the DAC curve: YM2149 steps are 3 dB apart for 4 bit volumes', () => {
	const peak = (vol: number): number => {
		const chip = new Ym2149({ sampleRate: RATE });
		toneOnA(chip, 100, vol);
		const out = renderMono(chip, 0.2);
		return Math.max(...out);
	};
	const ratio = peak(14) / peak(15);
	// two entries of the 1.5 dB per step table: 10^(-3/20) = 0.708
	assert.ok(Math.abs(ratio - 0.708) < 0.02, `ratio ${ratio}`);
	assert.equal(peak(0), 0);
	assert.ok(peak(15) > peak(8) && peak(8) > peak(1));
});

test('AY-3-8910 uses its 16 level table', () => {
	const chip = new Ym2149({ sampleRate: RATE, model: 'ay8910' });
	toneOnA(chip, 100, 15);
	const hi = Math.max(...renderMono(chip, 0.1));
	const chip2 = new Ym2149({ sampleRate: RATE, model: 'ay8910' });
	toneOnA(chip2, 100, 8);
	const mid = Math.max(...renderMono(chip2, 0.1));
	assert.ok(Math.abs(mid / hi - 0.12659) < 0.01, `ratio ${mid / hi}`);
});

test('noise changes faster with a smaller period and is silent when disabled', () => {
	const flips = (period: number): number => {
		const chip = new Ym2149({ sampleRate: RATE });
		chip.write(6, period);
		chip.write(8, 15);
		chip.write(7, 0b110111); // noise A only
		const out = renderMono(chip, 0.5);
		let n = 0;
		for (let i = 1; i < out.length; i++) if (Math.abs(out[i] - out[i - 1]) > 0.02) n++;
		return n;
	};
	assert.ok(flips(2) > flips(24) * 2, `${flips(2)} vs ${flips(24)}`);
	const quiet = new Ym2149({ sampleRate: RATE });
	quiet.write(8, 15); // mixer left at power-on: everything disabled, the output idles at the channel level
	const idle = renderMono(quiet, 0.05);
	assert.ok(
		idle.every((v) => Math.abs(v - idle[0]) < 1e-6),
		'a channel with tone and noise both off is a constant level',
	);
});

test('envelope shapes: \\___ decays and stays at zero, /--- rises and holds, \\/\\/ keeps going', () => {
	const run = (shape: number): number[] => {
		const chip = new Ym2149({ sampleRate: RATE });
		chip.write(8, 0x10); // envelope on channel A, mixer off = constant output equal to the level
		chip.write(11, 232); // period 1000: one step every 4 ms, a 32 step ramp lasts 128 ms
		chip.write(12, 3);
		chip.write(13, shape);
		const out = renderMono(chip, 0.6);
		const marks: number[] = [];
		for (let i = 0; i < 12; i++) marks.push(out[Math.floor((i / 12) * out.length) + 5]);
		return marks;
	};
	const decay = run(0);
	assert.ok(decay[0] > decay[1] && decay[1] > decay[2], 'decays');
	assert.ok(decay[11] < 1e-6, 'stays at zero afterwards');
	const rise = run(13);
	assert.ok(rise[0] < rise[1] && rise[1] < rise[2], 'rises');
	assert.ok(Math.abs(rise[11] - rise[10]) < 1e-6 && rise[11] > 0.3, 'holds at maximum');
	const tri = run(10);
	assert.ok(
		tri.some((v, i) => i > 0 && v > tri[i - 1]) && tri.some((v, i) => i > 0 && v < tri[i - 1]),
		'goes up and down',
	);
});

test('writing register 13 restarts the envelope', () => {
	const chip = new Ym2149({ sampleRate: RATE });
	chip.write(8, 0x10);
	chip.write(11, 5);
	chip.write(13, 0);
	renderMono(chip, 0.3); // fully decayed
	chip.write(13, 0);
	const out = renderMono(chip, 0.001);
	assert.ok(out[0] > 0.2, 'the level is back at maximum');
});

test('channel pan places the sound and mutes silence one channel', () => {
	const chip = new Ym2149({ sampleRate: RATE, pan: [-1, 0, 1] });
	chip.write(0, 100);
	chip.write(8, 15);
	chip.write(7, 0b111110);
	const l = new Float32Array(2000);
	const r = new Float32Array(2000);
	chip.render(l, r, 0, 2000);
	assert.ok(Math.max(...l) > 0.1 && Math.max(...r) < 1e-4, 'channel A hard left');
	chip.setMuted(0, true);
	const l2 = new Float32Array(2000);
	const r2 = new Float32Array(2000);
	chip.render(l2, r2, 0, 2000);
	assert.ok(Math.max(...l2.subarray(10)) === 0, 'muted channel is silent');
});

test('register masks match the hardware and reads return what was written', () => {
	const chip = new Ym2149();
	chip.write(1, 0xff);
	assert.equal(chip.read(1), 0x0f);
	chip.write(6, 0xff);
	assert.equal(chip.read(6), 0x1f);
	chip.write(13, 0xff);
	assert.equal(chip.read(13), 0x0f);
});

test('render adds into the buffers instead of overwriting', () => {
	const chip = new Ym2149({ sampleRate: RATE });
	toneOnA(chip, 100, 15);
	const l = new Float32Array(100).fill(1);
	const r = new Float32Array(100).fill(1);
	chip.render(l, r, 0, 100);
	assert.ok(l.every((v) => v >= 1));
});

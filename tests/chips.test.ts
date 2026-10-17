import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sn76489 } from '../src/chips/Sn76489.ts';
import { NesApu } from '../src/chips/NesApu.ts';
import { Sid } from '../src/chips/Sid.ts';
import { Opl } from '../src/chips/Opl.ts';
import { Ym2612 } from '../src/chips/Ym2612.ts';
import { Ym2151 } from '../src/chips/Ym2151.ts';
import { Opn } from '../src/chips/Opn.ts';
import { frequency, peak, renderMono, renderStereo, rms, RATE } from './util.ts';

// ---------- SN76489 ----------
test('SN76489 tone frequency is clock / (32 * period)', () => {
	const chip = new Sn76489({ sampleRate: RATE, clock: 3_579_545 });
	const period = 254; // about 440.4 Hz
	chip.write(0, 0x80 | (period & 15));
	chip.write(0, period >> 4);
	chip.write(0, 0x90); // volume 0 = loudest
	const out = renderMono(chip, 1);
	const expected = 3_579_545 / (32 * period);
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - expected) < 0.2, `${frequency(out, RATE)} vs ${expected}`);
});

test('SN76489 attenuation is 2 dB per step and 15 is silent; noise runs and periodic noise differs', () => {
	const level = (att: number): number => {
		const chip = new Sn76489({ sampleRate: RATE });
		chip.write(0, 0x80 | 5);
		chip.write(0, 0);
		chip.write(0, 0x90 | att);
		return peak(renderMono(chip, 0.1));
	};
	assert.ok(Math.abs(level(1) / level(0) - 10 ** (-2 / 20)) < 0.02);
	assert.equal(level(15), 0);
	const noise = (mode: number): Float32Array => {
		const chip = new Sn76489({ sampleRate: RATE });
		chip.write(0, 0xe0 | mode);
		chip.write(0, 0xf0);
		return renderMono(chip, 0.3);
	};
	const white = noise(4);
	const periodic = noise(0);
	assert.ok(rms(white) > 0.01 && rms(periodic) > 0.01);
	assert.notDeepEqual(white, periodic);
});

// ---------- NES APU ----------
test('NES pulse frequency is cpu / (16 * (period + 1)), duty changes the harmonic content', () => {
	const chip = new NesApu({ sampleRate: RATE });
	chip.write(0x4015, 1);
	chip.write(0x4000, 0xbf); // duty 50 %, halt, constant volume 15
	const period = 253;
	chip.write(0x4002, period & 255);
	chip.write(0x4003, period >> 8);
	const out = renderMono(chip, 1);
	const expected = 1_789_773 / (16 * (period + 1));
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - expected) < 0.3, `${frequency(out, RATE)} vs ${expected}`);
});

test('NES length counter silences a channel and the sweep unit moves the pitch', () => {
	const chip = new NesApu({ sampleRate: RATE });
	chip.write(0x4015, 1);
	chip.write(0x4000, 0x1f); // no halt, constant volume 15
	chip.write(0x4002, 0x80);
	chip.write(0x4003, 0x18 | 0); // length index 3 -> 2 half frames
	const early = renderMono(chip, 0.02);
	const later = renderMono(chip, 0.3);
	assert.ok(rms(early) > 0.005, 'sounds at first');
	assert.ok(rms(later, 2000) < 0.001, 'silent after the length counter ran out');

	const sweep = new NesApu({ sampleRate: RATE });
	sweep.write(0x4015, 1);
	sweep.write(0x4000, 0xbf);
	sweep.write(0x4001, 0x83); // enabled, period 0, add, shift 3: the period grows 12.5 % every half frame
	sweep.write(0x4002, 0x40);
	sweep.write(0x4003, 0x00);
	const a = renderMono(sweep, 0.03);
	const b = renderMono(sweep, 0.12);
	assert.ok(peak(b) > 0.01);
	assert.ok(frequency(b, RATE) < frequency(a, RATE) * 0.8, 'pitch falls as the period grows');
});

test('NES triangle and noise produce sound, mixer is non-linear', () => {
	const tri = new NesApu({ sampleRate: RATE });
	tri.write(0x4015, 4);
	tri.write(0x4008, 0xff);
	tri.write(0x400a, 0xfd);
	tri.write(0x400b, 0x00);
	const t = renderMono(tri, 0.5);
	const expected = 1_789_773 / (32 * (0xfd + 1));
	assert.ok(Math.abs(frequency(t, RATE, RATE / 4) - expected) < 0.5, `${frequency(t, RATE)} vs ${expected}`);
	const noise = new NesApu({ sampleRate: RATE });
	noise.write(0x4015, 8);
	noise.write(0x400c, 0x3f);
	noise.write(0x400e, 0x04);
	noise.write(0x400f, 0x08);
	assert.ok(rms(renderMono(noise, 0.2)) > 0.01);
	// two pulses at the same volume are less than twice as loud as one
	const one = new NesApu({ sampleRate: RATE });
	const two = new NesApu({ sampleRate: RATE });
	for (const [chip, mask] of [
		[one, 1],
		[two, 3],
	] as const) {
		chip.write(0x4015, mask);
		for (const base of [0x4000, 0x4004]) {
			chip.write(base, 0xbf);
			chip.write(base + 2, 0x80);
			chip.write(base + 3, 0x00);
		}
	}
	const r1 = rms(renderMono(one, 0.3), 3000);
	const r2 = rms(renderMono(two, 0.3), 3000);
	assert.ok(r2 < r1 * 1.99 && r2 > r1, `${r2} vs ${r1}`);
});

test('NES DPCM plays samples read through the memory callback', () => {
	const mem = new Uint8Array(0x10000).fill(0xaa); // alternating bits: a square wave around the start level
	const chip = new NesApu({ sampleRate: RATE, readMemory: (a) => mem[a] });
	chip.write(0x4010, 0x0f);
	chip.write(0x4011, 0x40);
	chip.write(0x4012, 0);
	chip.write(0x4013, 0x10);
	chip.write(0x4015, 0x10);
	assert.ok(rms(renderMono(chip, 0.05)) > 0.0005);
});

// ---------- SID ----------
function sidTone(model: 'mos6581' | 'mos8580', waveform: number): Sid {
	const chip = new Sid({ sampleRate: RATE, model });
	chip.write(24, 0x0f);
	const freq = Math.round((440 * 16777216) / 985248);
	chip.write(0, freq & 255);
	chip.write(1, freq >> 8);
	chip.write(2, 0x00);
	chip.write(3, 0x08); // pulse width 50 %
	chip.write(5, 0x00); // attack 2 ms
	chip.write(6, 0xf0); // sustain 15
	chip.write(4, (waveform << 4) | 1);
	return chip;
}

test('SID oscillator frequency is f * clock / 2^24 for triangle, saw and pulse', () => {
	for (const wf of [1, 2, 4]) {
		const out = renderMono(sidTone('mos6581', wf), 1);
		assert.ok(Math.abs(frequency(out, RATE, RATE / 2) - 440) < 0.5, `waveform ${wf}: ${frequency(out, RATE)}`);
	}
});

test('SID noise is noisy, gate release fades the envelope, sync and ring mod change the sound', () => {
	const noise = renderMono(sidTone('mos6581', 8), 0.3);
	assert.ok(rms(noise, 2000) > 0.05);
	const chip = sidTone('mos6581', 2);
	renderMono(chip, 0.2);
	chip.write(6, 0xf0); // release 0: 6 ms * 3 per ... fast
	chip.write(4, 0x20); // gate off
	renderMono(chip, 0.3);
	assert.ok(rms(renderMono(chip, 0.1)) < 0.01, 'silent after release');
	// hard sync: voice 1 restarts every period of voice 3, so the waveform repeats at the master's 300 Hz
	const lag = Math.round(RATE / 300);
	const repeat = (control: number): number => {
		const sync = new Sid({ sampleRate: RATE });
		sync.write(24, 0x0f);
		const f = (hz: number): number => Math.round((hz * 16777216) / 985248);
		sync.write(14, f(300) & 255);
		sync.write(15, f(300) >> 8);
		sync.write(0, f(1000) & 255);
		sync.write(1, f(1000) >> 8);
		sync.write(5, 0);
		sync.write(6, 0xf0);
		sync.write(4, control);
		const out = renderMono(sync, 0.5);
		let diff = 0;
		for (let i = 8000; i < 16000; i++) diff += Math.abs(out[i] - out[i + lag]);
		return diff / 8000;
	};
	assert.ok(repeat(0x23) < repeat(0x21) * 0.2, `${repeat(0x23)} vs ${repeat(0x21)}`);
});

test('SID low-pass filter attenuates a high tone more than a low cut-off does', () => {
	const run = (fc: number): number => {
		const chip = sidTone('mos8580', 2);
		chip.write(21, fc & 7);
		chip.write(22, fc >> 3);
		chip.write(23, 0x01); // route voice 1 through the filter
		chip.write(24, 0x1f); // low-pass, volume 15
		return rms(renderMono(chip, 0.3), 3000);
	};
	assert.ok(run(20) < run(1900) * 0.6, `${run(20)} vs ${run(1900)}`);
});

// ---------- OPL ----------
function oplTone(variant: 'opl2' | 'opl3', ch = 0): Opl {
	const chip = new Opl({ sampleRate: RATE, variant });
	if (variant === 'opl3') chip.write(0x105, 1);
	chip.write(0x01, 0x20);
	oplChannel(chip, ch);
	return chip;
}

function oplChannel(chip: Opl, ch: number): void {
	const bank = ch >= 9 ? 0x100 : 0;
	const c = ch % 9;
	const modOff = [0, 1, 2, 8, 9, 10, 16, 17, 18][c];
	const carOff = modOff + 3;
	chip.write(bank + 0x20 + modOff, 0x01);
	chip.write(bank + 0x40 + modOff, 0x3f); // modulator silent
	chip.write(bank + 0x60 + modOff, 0xf0);
	chip.write(bank + 0x80 + modOff, 0x0f);
	chip.write(bank + 0x20 + carOff, 0x21); // sustained, multiplier 1
	chip.write(bank + 0x40 + carOff, 0x00);
	chip.write(bank + 0x60 + carOff, 0xf0);
	chip.write(bank + 0x80 + carOff, 0x0f);
	chip.write(bank + 0xc0 + c, 0x31);
	chip.write(bank + 0xa0 + c, 580 & 255);
	chip.write(bank + 0xb0 + c, 0x20 | (4 << 2) | (580 >> 8));
}

test('OPL2 pitch is fnum * 49716 / 2^(20 - block) and key off releases the note', () => {
	const chip = oplTone('opl2');
	const out = renderMono(chip, 1);
	const expected = (580 * 3_579_545) / 72 / 2 ** 16;
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - expected) < 0.5, `${frequency(out, RATE)} vs ${expected}`);
	assert.ok(peak(out, 2000) > 0.2);
	chip.write(0xb0, (4 << 2) | (580 >> 8)); // key off
	renderMono(chip, 0.5);
	assert.ok(peak(renderMono(chip, 0.1)) < 0.01);
});

test('OPL waveforms differ and the multiplier doubles the pitch', () => {
	const sine = renderMono(oplTone('opl2'), 0.2);
	const withWave = (wf: number): Float32Array => {
		const c = oplTone('opl2');
		c.write(0xe3, wf);
		return renderMono(c, 0.2);
	};
	const half = withWave(1);
	assert.ok(Math.min(...half) > -0.03 && Math.max(...half) > 0.1, 'half-sine has no negative part');
	assert.notDeepEqual(sine, half);
	const doubled = oplTone('opl2');
	doubled.write(0x23, 0x22);
	assert.ok(
		Math.abs(
			frequency(renderMono(doubled, 1), RATE, RATE / 4) /
				frequency(renderMono(oplTone('opl2'), 1), RATE, RATE / 4) -
				2,
		) < 0.02,
	);
});

test('OPL FM modulation adds harmonics, total level lowers the volume 0.75 dB per step', () => {
	const plain = oplTone('opl2');
	const fm = oplTone('opl2');
	fm.write(0xc0, 0x30); // FM connection
	fm.write(0x40, 0x10); // audible modulator
	const a = renderMono(plain, 0.3);
	const b = renderMono(fm, 0.3);
	assert.notDeepEqual(a, b);
	const quiet = oplTone('opl2');
	quiet.write(0x43, 8); // 6 dB down
	const ratio = peak(renderMono(quiet, 0.2), 1000) / peak(a, 1000);
	assert.ok(Math.abs(ratio - 0.5) < 0.04, `ratio ${ratio}`);
});

test('OPL3 plays on the second bank, in stereo, and 4-operator pairs sound', () => {
	const chip = oplTone('opl3', 9);
	const l = new Float32Array(RATE / 2);
	const r = new Float32Array(RATE / 2);
	chip.render(l, r, 0, l.length);
	assert.ok(peak(l, 2000) > 0.2 && peak(r, 2000) > 0.2);
	chip.write(0x1c0, 0x11); // additive connection, left output only
	const l2 = new Float32Array(2000);
	const r2 = new Float32Array(2000);
	chip.render(l2, r2, 0, 2000);
	assert.ok(peak(l2, 500) > 0.1 && peak(r2, 500) < 0.001, 'left-only panning');
	const four = oplTone('opl3', 0);
	oplChannel(four, 3); // the second half of the pair carries its own operators
	four.write(0x104, 1); // channels 1 + 4 as a 4-operator voice
	assert.ok(peak(renderMono(four, 0.3), 1000) > 0.05);
});

test('OPL rhythm mode makes percussion noise', () => {
	const chip = new Opl({ sampleRate: RATE });
	chip.write(0x01, 0x20);
	for (const off of [16, 17, 18, 19, 20, 21, 8, 9, 10, 11, 12, 13]) {
		chip.write(0x20 + off, 0x01);
		chip.write(0x40 + off, 0x00);
		chip.write(0x60 + off, 0xf8);
		chip.write(0x80 + off, 0x08);
	}
	for (const c of [6, 7, 8]) {
		chip.write(0xa0 + c, 0x00);
		chip.write(0xb0 + c, 0x08 | 1);
	}
	chip.write(0xbd, 0x20 | 0x1f);
	assert.ok(rms(renderMono(chip, 0.2)) > 0.01);
});

// ---------- YM2612 ----------
function ymTone(alg = 7): Ym2612 {
	const chip = new Ym2612({ sampleRate: RATE });
	chip.write(0x22, 0);
	// channel 1: only operator 4 (register slot S4 = offset 12) audible, in algorithm 7 all ops are carriers
	for (const off of [0, 4, 8, 12]) {
		chip.write(0x30 + off, 0x01);
		chip.write(0x40 + off, off === 12 ? 0x00 : 0x7f);
		chip.write(0x50 + off, 0x1f);
		chip.write(0x60 + off, 0x00);
		chip.write(0x70 + off, 0x00);
		chip.write(0x80 + off, 0x0f);
	}
	chip.write(0xb0, alg);
	chip.write(0xb4, 0xc0);
	const fnum = 1093; // block 4: f = fnum * 2^4 * fs / 2^21
	chip.write(0xa4, (4 << 3) | (fnum >> 8));
	chip.write(0xa0, fnum & 255);
	chip.write(0x28, 0xf0);
	return chip;
}

test('YM2612 pitch is fnum * 2^block * (clock / 144) / 2^21', () => {
	const out = renderMono(ymTone(), 1);
	const expected = (1093 * 16 * (7_670_454 / 144)) / 2 ** 21;
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - expected) < 0.6, `${frequency(out, RATE)} vs ${expected}`);
	assert.ok(peak(out, 2000) > 0.1);
});

test('YM2612 key off releases, panning selects the side, the DAC plays 8 bit samples', () => {
	const chip = ymTone();
	renderMono(chip, 0.2);
	chip.write(0x28, 0x00);
	renderMono(chip, 1);
	assert.ok(peak(renderMono(chip, 0.1)) < 0.01);
	const pan = ymTone();
	pan.write(0xb4, 0x80); // left only
	const l = new Float32Array(4000);
	const r = new Float32Array(4000);
	pan.render(l, r, 0, 4000);
	assert.ok(peak(l, 1000) > 0.05 && peak(r, 1000) < 1e-4);
	const dac = new Ym2612({ sampleRate: RATE });
	dac.write(0x2b, 0x80);
	dac.write(0xb6, 0xc0);
	dac.write(0x2a, 0xff);
	assert.ok(peak(renderMono(dac, 0.05), 100) > 0.1);
});

test('YM2612 algorithms 0 and 7 differ and feedback changes the timbre', () => {
	const audibleOp1 = (chip: Ym2612): Ym2612 => {
		chip.write(0x40, 0x00);
		return chip;
	};
	const a = renderMono(audibleOp1(ymTone(0)), 0.2);
	const b = renderMono(audibleOp1(ymTone(7)), 0.2);
	assert.notDeepEqual(a, b);
	const fb = audibleOp1(ymTone(7));
	fb.write(0xb0, 0x38 | 7);
	assert.notDeepEqual(renderMono(fb, 0.2), b);
});

// ---------- YM2151 ----------
test('YM2151: A4 (KC 0x4A) is 440 Hz, key off releases, algorithms and pan work', () => {
	const mk = (alg = 7): Ym2151 => {
		const chip = new Ym2151({ sampleRate: RATE });
		chip.write(0x20, 0xc0 | alg); // both outputs
		chip.write(0x28, 0x4a);
		chip.write(0x30, 0);
		for (let slot = 0; slot < 4; slot++) {
			const off = slot * 8;
			chip.write(0x40 + off, 0x01);
			chip.write(0x60 + off, slot === 3 ? 0 : 127); // register slot 3 = C2 (operator 4), the carrier
			chip.write(0x80 + off, 0x1f);
			chip.write(0xa0 + off, 0);
			chip.write(0xc0 + off, 0);
			chip.write(0xe0 + off, 0x0f);
		}
		chip.write(0x08, 0x78); // key on, all four operators of channel 0
		return chip;
	};
	const out = renderMono(mk(), 1);
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - 440) < 0.8, `${frequency(out, RATE)}`);
	assert.ok(peak(out, 2000) > 0.1);
	const chip = mk();
	renderMono(chip, 0.2);
	chip.write(0x08, 0x00);
	renderMono(chip, 1);
	assert.ok(peak(renderMono(chip, 0.1)) < 0.01);
	const left = mk();
	left.write(0x20, 0x80 | 7);
	const [l, r] = renderStereo(left, 0.2);
	assert.ok(peak(l, 1000) > 0.1 && peak(r, 1000) < 1e-5);
});

// ---------- YM2203 / YM2608 (OPN family) ----------
test('YM2203: the SSG runs at clock / 4 and the 3 FM channels at clock / 72', () => {
	const clock = 3_993_600;
	const chip = new Opn({ sampleRate: RATE, clock });
	// SSG tone A, period 100: f = clock / 4 / (16 * 100) = 624 Hz
	chip.write(0, 100);
	chip.write(1, 0);
	chip.write(7, 0x3e);
	chip.write(8, 15);
	const ssg = renderMono(chip, 1);
	assert.ok(Math.abs(frequency(ssg, RATE, RATE / 4) - clock / 4 / 1600) < 0.8, `${frequency(ssg, RATE)}`);
	// FM channel 1, algorithm 7, only operator 4 audible: f = fnum * 2^block * (clock / 72) / 2^21
	const fm = new Opn({ sampleRate: RATE, clock });
	for (const off of [0, 4, 8, 12]) {
		fm.write(0x30 + off, 0x01);
		fm.write(0x40 + off, off === 12 ? 0 : 0x7f);
		fm.write(0x50 + off, 0x1f);
		fm.write(0x80 + off, 0x0f);
	}
	fm.write(0xb0, 7);
	fm.write(0xa4, (4 << 3) | (1093 >> 8));
	fm.write(0xa0, 1093 & 255);
	fm.write(0x28, 0xf0);
	const out = renderMono(fm, 1);
	const expected = (1093 * 16 * (clock / 72)) / 2 ** 21;
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - expected) < 0.7, `${frequency(out, RATE)} vs ${expected}`);
	assert.equal(fm.channels, 6, '3 FM channels + 3 SSG channels');
	// the prescaler register changes the SSG clock
	chip.write(0x2f, 0);
	assert.ok(Math.abs(frequency(renderMono(chip, 1), RATE, RATE / 4) - clock / 1600) < 3);
});

test('YM2608 has six FM channels through the two register banks', () => {
	const chip = new Opn({ sampleRate: RATE, variant: 'ym2608', clock: 7_987_200 });
	for (const off of [0, 4, 8, 12]) {
		chip.write(0x100 | (0x30 + off), 0x01);
		chip.write(0x100 | (0x40 + off), off === 12 ? 0 : 0x7f);
		chip.write(0x100 | (0x50 + off), 0x1f);
		chip.write(0x100 | (0x80 + off), 0x0f);
	}
	chip.write(0x1b0, 7);
	chip.write(0x1a4, (4 << 3) | (1093 >> 8));
	chip.write(0x1a0, 1093 & 255);
	chip.write(0x28, 0xf4); // channel 4 (index 4 = port 1, channel 1)
	const out = renderMono(chip, 1);
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - (1093 * 16 * (7_987_200 / 144)) / 2 ** 21) < 1);
	assert.equal(chip.channels, 9);
});

test('YM2608 ADPCM-B decodes the delta-T stream from external memory at delta-N / 65536 of the FM rate', () => {
	const chip = new Opn({ sampleRate: RATE, variant: 'ym2608', clock: 7_987_200 });
	// 512 bytes (1024 nibbles) of a square-ish pattern: 8 nibbles up (0x7), 8 nibbles down (0xF)
	const mem = new Uint8Array(512);
	for (let i = 0; i < 512; i++) mem[i] = ((i >> 2) & 1 ? 0xff : 0x77) as number;
	chip.setAdpcmMemory(mem);
	const w = (r: number, v: number): void => chip.write(0x100 | r, v);
	w(0x01, 0xc0); // both sides
	w(0x02, 0);
	w(0x03, 0); // start 0
	w(0x04, 15);
	w(0x05, 0); // stop: (15 + 1) * 32 = 512 bytes
	w(0x09, 0x00);
	w(0x0a, 0x40); // delta-N 0x4000: a quarter of the FM native rate
	w(0x0b, 0xff);
	w(0x00, 0x80 | 0x10); // start, repeat
	const out = renderMono(chip, 0.5);
	assert.ok(peak(out, 1000) > 0.05, 'the sample plays');
	// one period is 16 nibbles at (7987200 / 144) / 4 = 13867 Hz: 866.7 Hz
	assert.ok(Math.abs(frequency(out, RATE, RATE / 8) - 13866.7 / 16) < 8, `${frequency(out, RATE)}`);
	w(0x00, 0x01); // reset
	assert.ok(peak(renderMono(chip, 0.2)) < 1e-3, 'stopped');
});

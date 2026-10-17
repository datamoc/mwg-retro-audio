import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PcSpeaker, PIT_CLOCK } from '../src/chips/PcSpeaker.ts';
import { Saa1099 } from '../src/chips/Saa1099.ts';
import { PcmDac } from '../src/chips/PcmDac.ts';
import { OutputProfiles, OutputStage } from '../src/driver/OutputStage.ts';
import { frequency, peak, renderMono, renderStereo, rms, RATE } from './util.ts';

function pcTone(divisor: number): PcSpeaker {
	const chip = new PcSpeaker({ sampleRate: RATE });
	chip.write(0x43, 0xb6); // channel 2, lobyte/hibyte, mode 3
	chip.write(0x42, divisor & 255);
	chip.write(0x42, divisor >> 8);
	chip.write(0x61, 3);
	return chip;
}

test('PC speaker: frequency is 1 193 182 / divisor', () => {
	const out = renderMono(pcTone(2712), 1); // about 440 Hz
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - PIT_CLOCK / 2712) < 0.3, `${frequency(out, RATE)}`);
	assert.ok(Math.abs(pcTone(2712).toneHz - 439.9) < 0.1);
});

test('PC speaker: closing the speaker bit silences it, 1 bit PWM through port 0x61 reproduces a sine', () => {
	const chip = pcTone(2712);
	chip.write(0x61, 0);
	const quiet = renderMono(chip, 0.05);
	assert.ok(
		quiet.every((v) => v === quiet[0]),
		'constant level when the speaker is off',
	);
	// 1 bit digitised sound (RealSound / PWM style): the program toggles bit 1 of port 0x61 with the gate closed;
	// a first order sigma-delta modulator turns a 440 Hz sine into one bit per output sample
	const pwm = new PcSpeaker({ sampleRate: RATE });
	const n = RATE;
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	let acc = 0;
	for (let i = 0; i < n; i++) {
		const target = 0.8 * Math.sin((2 * Math.PI * 440 * i) / RATE);
		const bit = acc + target >= 0 ? 1 : 0;
		acc += target - (bit ? 1 : -1);
		pwm.write(0x61, bit ? 2 : 0);
		pwm.render(l, r, i, 1);
	}
	new OutputStage(RATE, { lowpass: 1500, lowpassOrder: 2 }).process(l, r, 0, n);
	assert.ok(Math.abs(frequency(l, RATE, RATE / 4) - 440) < 1, `${frequency(l, RATE)}`);
	assert.ok(rms(l, 5000) > 0.1);
});

test('PC speaker output profile removes the bass and the highs', () => {
	const stage = (hz: number): number => {
		const chip = pcTone(Math.round(PIT_CLOCK / hz));
		const [l, r] = renderStereo(chip, 0.5);
		new OutputStage(RATE, OutputProfiles.pcSpeaker).process(l, r, 0, l.length);
		return rms(l, 5000);
	};
	assert.ok(stage(1000) > stage(60) * 2, `${stage(1000)} vs ${stage(60)}`);
	assert.ok(stage(1000) > stage(9000) * 2);
});

test('SAA1099: frequency is clock / 512 * 2^octave / (511 - f), amplitude and stereo', () => {
	const chip = new Saa1099({ sampleRate: RATE, clock: 8_000_000 });
	chip.write(0x1c, 1);
	chip.write(0x00, 0xf0); // channel 0: right only, amplitude 15
	chip.write(0x08, 200);
	chip.write(0x10, 0x04); // octave 4
	chip.write(0x14, 0x01); // frequency enabled on channel 0
	const [l, r] = renderStereo(chip, 1);
	const expected = ((8_000_000 / 512) * 16) / (511 - 200);
	assert.ok(Math.abs(frequency(r, RATE, RATE / 4) - expected) < 1.5, `${frequency(r, RATE)} vs ${expected}`);
	assert.ok(peak(r) > 0.05 && peak(l) < 1e-6, 'right channel only');
});

test('SAA1099: noise, envelope and the global enable', () => {
	const chip = new Saa1099({ sampleRate: RATE });
	chip.write(0x1c, 1);
	chip.write(0x00, 0xff);
	chip.write(0x15, 0x01);
	chip.write(0x16, 0x00);
	assert.ok(rms(renderMono(chip, 0.2)) > 0.01, 'noise on channel 0');
	chip.write(0x1c, 0);
	assert.ok(peak(renderMono(chip, 0.05)) === 0, 'sound disabled');
	const env = new Saa1099({ sampleRate: RATE });
	env.write(0x1c, 1);
	env.write(0x02, 0xff);
	env.write(0x0a, 150);
	env.write(0x11, 0x03);
	env.write(0x14, 0x04);
	env.write(0x18, 0x80 | (3 << 1)); // repeated decay envelope on channel 2
	const out = renderMono(env, 0.5);
	assert.ok(peak(out) > 0.02);
});

test('PCM DAC holds the last written value; 16 bit signed and stereo variants', () => {
	const dac = new PcmDac({ sampleRate: RATE });
	dac.write(0, 0xff);
	const [l, r] = renderStereo(dac, 0.01);
	assert.ok(Math.abs(l[10] - 127 / 128) < 1e-6 && l[10] === r[10]);
	dac.write(0, 0x00);
	assert.equal(renderMono(dac, 0.01)[0], -1);
	const st = new PcmDac({ sampleRate: RATE, bits: 16, stereo: true });
	st.write(0, 0x4000);
	st.write(1, 0xc000);
	const [a, b] = renderStereo(st, 0.01);
	assert.ok(Math.abs(a[0] - 0.5) < 1e-6 && Math.abs(b[0] + 0.5) < 1e-6);
});

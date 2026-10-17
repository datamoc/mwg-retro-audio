import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CmsCard, SoundBlasterCard } from '../src/chips/cards.ts';
import { createChip } from '../src/chips/index.ts';
import { frequency, peak, renderMono, renderStereo, rms, RATE } from './util.ts';

test('C/MS: two SAA1099 reachable through the 0x220-0x223 ports give 12 voices in stereo', () => {
	const card = new CmsCard({ sampleRate: RATE, clock: 8_000_000 });
	const reg = (chip: 0 | 1, r: number, v: number): void => {
		card.write(0x221 + chip * 2, r);
		card.write(0x220 + chip * 2, v);
	};
	reg(0, 0x1c, 1);
	reg(1, 0x1c, 1);
	reg(0, 0x00, 0x0f); // chip 1 channel 0: left
	reg(0, 0x08, 200);
	reg(0, 0x10, 0x04);
	reg(0, 0x14, 1);
	reg(1, 0x00, 0xf0); // chip 2 channel 0: right
	reg(1, 0x08, 100);
	reg(1, 0x10, 0x05);
	reg(1, 0x14, 1);
	const [l, r] = renderStereo(card, 1);
	const f1 = ((8_000_000 / 512) * 16) / (511 - 200);
	const f2 = ((8_000_000 / 512) * 32) / (511 - 100);
	assert.ok(Math.abs(frequency(l, RATE, RATE / 4) - f1) < 1.5, `${frequency(l, RATE)} vs ${f1}`);
	assert.ok(Math.abs(frequency(r, RATE, RATE / 4) - f2) < 3, `${frequency(r, RATE)} vs ${f2}`);
	assert.equal(card.channels, 12);
	assert.equal(createChip('cms', { sampleRate: RATE }).id, 'cms');
});

test('Sound Blaster: AdLib ports and the DSP direct DAC mix together', () => {
	const card = new SoundBlasterCard({ sampleRate: RATE });
	const opl = (r: number, v: number): void => {
		card.write(0x388, r);
		card.write(0x389, v);
	};
	opl(0x01, 0x20);
	opl(0x23, 0x21);
	opl(0x43, 0x00);
	opl(0x63, 0xf0);
	opl(0x83, 0x0f);
	opl(0x20, 0x01);
	opl(0x40, 0x3f);
	opl(0xc0, 0x01);
	opl(0xa0, 580 & 255);
	opl(0xb0, 0x20 | (4 << 2) | (580 >> 8));
	assert.ok(Math.abs(frequency(renderMono(card, 1), RATE, RATE / 4) - 440) < 0.6);
	// direct DAC: command 0x10 then the byte
	card.write(0x22c, 0x10);
	card.write(0x22c, 0xff);
	assert.ok(Math.max(...renderMono(card, 0.02)) > 0.9, 'DC level of the DAC added to the OPL tone');
	// DSP version, time constant
	card.write(0x22c, 0xe1);
	assert.equal(card.read(0x22a), 2);
	card.write(0x22c, 0x40);
	card.write(0x22c, 193);
	assert.ok(Math.abs(card.dspRate - 1_000_000 / 63) < 0.01);
});

test('Sound Blaster: DMA playback of 8 bit PCM at the DSP rate', () => {
	const card = new SoundBlasterCard({ sampleRate: RATE });
	const n = 2000;
	const pcm = new Uint8Array(n).map((_, i) => (Math.floor(i / 8) % 2 ? 0xe0 : 0x20)); // square, 1000 Hz at 16 kHz
	card.setDmaBuffer(pcm);
	card.write(0x22c, 0x40);
	card.write(0x22c, 193); // 16 kHz
	card.write(0x22c, 0x14);
	card.write(0x22c, (n - 1) & 255);
	card.write(0x22c, (n - 1) >> 8);
	const out = renderMono(card, 0.1);
	assert.ok(Math.abs(frequency(out, RATE, 500) - 1000) < 20, `${frequency(out, RATE, 500)}`);
	const silent = renderMono(card, 0.2); // 2000 samples at 16 kHz = 0.125 s: the transfer is over
	assert.ok(rms(silent, 3000) < 1.0);
	assert.ok(peak(out) > 0.5);
});

test('Sound Blaster Pro has a left and a right OPL2', () => {
	const card = new SoundBlasterCard({ sampleRate: RATE, model: 'sbpro' });
	const prog =
		(a: number, d: number, side: 0 | 1): ((r: number, v: number) => void) =>
		(r, v) => {
			card.write(0x220 + a + side * 2, r);
			card.write(0x221 + a + side * 2, v);
			void d;
		};
	const left = prog(0, 0, 0);
	for (const [r, v] of [
		[0x01, 0x20],
		[0x23, 0x21],
		[0x43, 0],
		[0x63, 0xf0],
		[0x83, 0x0f],
		[0x20, 1],
		[0x40, 0x3f],
		[0xc0, 1],
		[0xa0, 580 & 255],
		[0xb0, 0x20 | (4 << 2) | 2],
	] as const)
		left(r, v);
	const [l, r] = renderStereo(card, 0.3);
	assert.ok(peak(l, 2000) > 0.1 && peak(r, 2000) < 1e-5);
});

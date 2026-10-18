import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D50Synth } from '../src/chips/historical.ts';
import {
	D50_PCM_NAMES,
	MODEL_D50,
	buildD50Dt1,
	inspectD50Patch,
	parseD50SysEx,
	readD50Memory,
} from '../src/formats/d50.ts';
import { D50_WAVE_ATTACKS, D50_WAVE_LOOPS } from '../src/chips/d50Waves.ts';
import { frequency, renderMono, rms, RATE } from './util.ts';

const NAME = ` ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890-`;
const text = (s: string, n: number): number[] =>
	Array.from({ length: n }, (_, i) => Math.max(0, NAME.indexOf(s[i] ?? ' ')));

/** a partial block (0x40 bytes) following the D-05 table: C4 standard pitch, no fine, saw, open filter, steady TVA */
function partial(over: Record<number, number> = {}): number[] {
	const b = new Array<number>(0x40).fill(0);
	Object.assign(b, {
		0x00: 36,
		0x01: 50,
		0x02: 11,
		0x06: 1,
		0x08: 50,
		0x0d: 100,
		0x0e: 0,
		0x12: 0,
		0x1b: 100,
		0x1c: 100,
		0x1d: 100,
		0x1e: 100,
		0x23: 100,
		0x27: 0,
		0x28: 0,
		0x29: 0,
		0x2a: 0,
		0x2b: 10,
		0x2c: 100,
		0x2d: 100,
		0x2e: 100,
		0x2f: 100,
	});
	return Object.assign(b, over);
}
function common(nm: string, over: Record<number, number> = {}): number[] {
	const b = new Array<number>(0x40).fill(0);
	b.splice(0, 10, ...text(nm, 10));
	Object.assign(b, { 0x0a: 0, 0x2e: 3, 0x2f: 50 });
	return Object.assign(b, over);
}
function patchBlock(nm: string, over: Record<number, number> = {}): number[] {
	const b = new Array<number>(0x40).fill(0);
	b.splice(0, 18, ...text(nm, 18));
	Object.assign(b, { 0x12: 0, 0x16: 24, 0x17: 24, 0x18: 50, 0x19: 50, 0x21: 50 });
	return Object.assign(b, over);
}
const MEM1 = 2 << 14; // patch memory 1-1 (02 00 00)

/** a whole patch as D-50 DT1 messages of at most 256 bytes, like a bulk dump */
function dump(base: number, blocks: number[][]): Uint8Array {
	const data = blocks.flat();
	const msgs: Uint8Array[] = [];
	for (let o = 0; o < data.length; o += 128) msgs.push(buildD50Dt1(0, base + o, data.slice(o, o + 128)));
	return Uint8Array.from(msgs.flatMap((m) => [...m]));
}
const UPPER = [partial(), partial({ 0x06: 0 }), common('Upper')];
const LOWER = [partial(), partial(), common('Lower')];

test('D-50 SysEx: a patch memory dump is read, with its names, key mode and structure', () => {
	const syx = dump(MEM1, [...UPPER, ...LOWER, patchBlock('Test Patch', { 0x12: 1 })]);
	const [p, ...rest] = parseD50SysEx(syx);
	assert.equal(rest.length, 0);
	assert.equal(p.name, 'Test Patch');
	assert.deepEqual(p.toneNames, ['Upper', 'Lower']);
	assert.equal(p.keyMode, 'Dual');
	assert.equal(p.source, 'memory');
	assert.equal(p.slot, 1);
	assert.equal(p.patch.tones.length, 2, 'Dual layers both tones');
	assert.equal(p.patch.tones[0].partials[0].wave, 'saw');
	assert.equal(p.patch.tones[0].partials[1].wave, 'square');
});

test('D-50 SysEx: bad checksum and other models are ignored, the temporary area is found at address 0', () => {
	const syx = dump(0, [...UPPER, ...LOWER, patchBlock('Temp')]);
	assert.equal(parseD50SysEx(syx)[0].source, 'temporary');
	const bad = Uint8Array.from(syx);
	bad[bad.indexOf(0xf7) - 1] ^= 1;
	assert.equal(readD50Memory(bad).size < readD50Memory(syx).size, true);
	assert.deepEqual(
		parseD50SysEx(bad)[0].toneNames,
		['Lower'],
		'the corrupted upper tone is dropped, the lower one is kept',
	);
	const other = Uint8Array.from(syx);
	for (let i = 0; i < other.length; i++) if (other[i] === 0xf0) other[i + 3] = 0x16;
	assert.equal(parseD50SysEx(other).length, 0);
	assert.equal(MODEL_D50, 0x14);
});

test('D-50 SysEx: C4 standard pitch plays the key in tune, a coarse of C5 raises it an octave, structure picks PCM partials', () => {
	const play = (coarse: number): number => {
		const syx = dump(MEM1, [
			partial({ 0x00: coarse }),
			partial({ 0x2c: 0, 0x2d: 0, 0x2e: 0, 0x2f: 0 }),
			common('A'),
			partial(),
			partial(),
			common('B'),
			patchBlock('P'),
		]);
		const s = new D50Synth({ sampleRate: RATE });
		s.loadPatch(parseD50SysEx(syx)[0].patch);
		s.noteOn(69, 127);
		return frequency(renderMono(s, 1), RATE, RATE / 4);
	};
	assert.ok(Math.abs(play(36) - 440) < 3);
	assert.ok(Math.abs(play(48) - 880) < 6);
	const pcm = parseD50SysEx(
		dump(MEM1, [
			partial({ 0x07: 5, 0x2f: 0 }),
			partial(),
			common('S', { 0x0a: 2 }),
			partial(),
			partial(),
			common('L'),
			patchBlock('P'),
		]),
	)[0];
	assert.equal(pcm.patch.tones[0].structure, 3);
	assert.equal(pcm.patch.tones[0].partials[0].wave, 'attack');
	assert.equal(pcm.patch.tones[0].partials[1].wave, 'saw');
});

test('D-50 SysEx: envelopes, partial mute and the filter depth shape the sound that D50Synth plays', () => {
	const render = (over: Record<number, number>, mute = 3): Float32Array => {
		const syx = dump(MEM1, [
			partial(over),
			partial(),
			common('A', { 0x2e: mute }),
			partial(),
			partial(),
			common('B'),
			patchBlock('P'),
		]);
		const s = new D50Synth({ sampleRate: RATE });
		s.loadPatch(parseD50SysEx(syx)[0].patch);
		s.noteOn(60, 127);
		return renderMono(s, 1);
	};
	const open = render({ 0x0d: 100 }, 1);
	const dark = render({ 0x0d: 10 }, 1);
	const hf = (x: Float32Array): number => {
		let s = 0;
		for (let i = 1; i < x.length; i++) s += (x[i] - x[i - 1]) ** 2;
		return s / (rms(x) ** 2 * x.length);
	};
	assert.ok(hf(open) > hf(dark) * 2, 'a low cut-off is darker');
	const slow = render({ 0x27: 80, 0x2b: 10 }, 1);
	assert.ok(rms(slow, 0, 1000) < rms(open, 0, 1000) * 0.5, 'a slow TVA attack starts quieter');
	assert.ok(rms(render({}, 0), 2000) < 1e-6, 'both partials muted');
});

test('D-50 SysEx: ring structures keep partial 1 audible, a held PCM partial still sounds', () => {
	const play = (structure: number, p1: Record<number, number>, p2: Record<number, number>): Float32Array => {
		const syx = dump(MEM1, [
			partial(p1),
			partial(p2),
			common('R', { 0x0a: structure - 1 }),
			partial(),
			partial(),
			common('L'),
			patchBlock('P'),
		]);
		const s = new D50Synth({ sampleRate: RATE });
		const patch = parseD50SysEx(syx)[0].patch;
		s.loadPatch(patch);
		s.noteOn(60, 127);
		return renderMono(s, 1.5);
	};
	// structure 5 = synthesised partial 1 + PCM partial 2 in ring modulation: the short PCM attack must not silence it
	assert.ok(rms(play(5, {}, { 0x07: 3 }), 30000) > 0.01);
	// structure 6 = two PCM partials: spectral loops (waves 48-76) keep sounding while the key is down
	const held = play(6, { 0x07: 50 }, { 0x07: 60 });
	assert.ok(rms(held, 30000) > 0.01);
	// a PCM partial whose TVA falls to zero stays a one-shot attack
	const shot = parseD50SysEx(
		dump(MEM1, [
			partial({ 0x07: 3, 0x2f: 0 }),
			partial(),
			common('S', { 0x0a: 2 }),
			partial(),
			partial(),
			common('L'),
			patchBlock('P'),
		]),
	)[0];
	assert.equal(shot.patch.tones[0].partials[0].wave, 'attack');
});

test('D-50 SysEx: PCM waves follow the D-50 wave list: 1-47 attacks, 48-76 looped sounds (76 = Noise), 77-100 stand-ins', () => {
	const wave = (n: number) =>
		parseD50SysEx(
			dump(MEM1, [
				partial({ 0x07: n }),
				partial(),
				common('S', { 0x0a: 2 }),
				partial(),
				partial(),
				common('L'),
				patchBlock('P'),
			]),
		)[0].patch.tones[0].partials[0];
	assert.equal(D50_PCM_NAMES.length, 100);
	assert.deepEqual(
		[D50_PCM_NAMES[0], D50_PCM_NAMES[32], D50_PCM_NAMES[46], D50_PCM_NAMES[67], D50_PCM_NAMES[75]],
		['Marimba', 'Steam', 'Pizzicato', 'Spectrum 1', 'Noise'],
	);
	for (let n = 0; n < 47; n++)
		assert.ok(wave(n).wave === 'attack' && wave(n).recipe === D50_WAVE_ATTACKS[n], `attack ${n + 1}`);
	for (let n = 47; n < 75; n++)
		assert.ok(wave(n).wave === 'loop' && Math.max(...wave(n).loop!) === 1, `loop ${n + 1}`);
	assert.equal(wave(75).wave, 'noise');
	assert.equal(wave(76).wave, 'saw');
	assert.equal(wave(99).wave, 'saw');
	assert.equal(D50_WAVE_ATTACKS.length, 47);
	assert.equal(D50_WAVE_LOOPS.length, 29);
});

test('D-50 SysEx: tone balance (0 = lower only, 100 = upper only), tone key shift, and a muted partial that still feeds the ring', () => {
	const play = (block: number[], common1: Record<number, number> = {}): Float32Array => {
		const syx = dump(MEM1, [
			partial(),
			partial({ 0x06: 0 }),
			common('U', common1),
			partial(),
			partial({ 0x06: 0 }),
			common('L', common1),
			block,
		]);
		const s = new D50Synth({ sampleRate: RATE });
		s.loadPatch(parseD50SysEx(syx)[0].patch);
		s.noteOn(69, 127);
		return renderMono(s, 1);
	};
	const tones = (balance: number) =>
		parseD50SysEx(dump(MEM1, [...UPPER, ...LOWER, patchBlock('P', { 0x12: 1, 0x21: balance })]))[0].patch.tones;
	assert.equal(tones(0)[0].partials[0].level, 0, 'balance 0: the upper tone is silent');
	assert.ok(tones(0)[1].partials[0].level! > 0);
	assert.ok(
		tones(100)[0].partials[0].level! > 0 && tones(100)[1].partials[0].level === 0,
		'balance 100: the lower tone is silent',
	);
	const up = play(patchBlock('P', { 0x16: 36 })); // upper tone key shift +12 semitones
	assert.ok(Math.abs(frequency(up, RATE, RATE / 4) - 880) < 6, 'the tone key shift raises the upper tone an octave');
	const ring = (mute: number): number => rms(play(patchBlock('P'), { 0x0a: 1, 0x2e: mute }), 8000);
	assert.ok(ring(2) > 0.01, 'partial 1 muted in a ring structure: the ring modulation still sounds');
	assert.ok(ring(0) < 1e-6, 'both partials muted: silence');
});

test('D-50 SysEx: the published end points of the time, LFO and chorus laws, and key follow, pitch envelope, LFO mode', () => {
	const patch = (p1: Record<number, number>, c: Record<number, number> = {}) =>
		parseD50SysEx(
			dump(MEM1, [
				partial(p1),
				partial(),
				common('A', { 0x2e: 3, ...c }),
				partial(),
				partial(),
				common('B'),
				patchBlock('P'),
			]),
		)[0].patch;
	const near = (a: number, b: number, tol: number): boolean => Math.abs(a / b - 1) < tol;
	// service notes: TVA T1-T5 span 4 ms - 80 s
	assert.ok(near(patch({ 0x27: 0 }).tones[0].partials[0].amp[1][0], 0.004, 0.01));
	assert.ok(near(patch({ 0x27: 100 }).tones[0].partials[0].amp[1][0], 80, 0.01));
	// LFO rate 0.0004 - 27 Hz, pitch depth +-600 cents, delay 0 - 10 s, chorus rate 0.098 - 20 Hz
	const lfo = (c: Record<number, number>) => patch({}, { 0x16: 100, ...c }).tones[0].lfo!;
	assert.ok(near(lfo({ 0x1a: 0 }).rate, 0.0004, 0.01) && near(lfo({ 0x1a: 100 }).rate, 27, 0.01));
	assert.equal(lfo({}).pitchCents, 600);
	assert.ok(near(lfo({ 0x1b: 100 }).delay!, 10, 0.01) && lfo({ 0x1b: 0 }).delay === 0);
	const chorus = (r: number) => patch({}, { 0x2d: 50, 0x2b: r }).chorus!;
	assert.ok(near(chorus(0).rate!, 0.098, 0.01) && near(chorus(100).rate!, 20, 0.01));
	// pitch key follow: index 3 = 0 (the same note on every key), index 11 = 1, s1 = 1 + 1 cent per octave
	const rate = (kf: number, note: number): number => {
		const s = new D50Synth({ sampleRate: RATE });
		s.loadPatch(patch({ 0x02: kf }, { 0x2e: 1 }));
		s.noteOn(note, 127);
		return frequency(renderMono(s, 1), RATE, RATE / 4);
	};
	assert.ok(Math.abs(rate(3, 48) - rate(3, 72)) < 3, 'key follow 0: keys 48 and 72 play the same note');
	assert.ok(
		near(rate(11, 72), 2 * rate(11, 60), 0.01),
		'key follow 1: an octave up on the keyboard doubles the pitch',
	);
	assert.ok(
		near(rate(14, 72), 4 * rate(14, 60), 0.02),
		'key follow 2: whole-tone scale, an octave of keys is two octaves of pitch',
	);
	// pitch envelope mode (+): L0 +50 = one octave up at the start, (-) goes the other way, Off ignores it
	const penv = (mode: number) =>
		patch({ 0x04: mode }, { 0x11: 100, 0x12: 50, 0x13: 50, 0x14: 50 }).tones[0].partials[0].pitchEnv;
	assert.equal(penv(0), undefined);
	assert.ok(near(penv(1)![0][1], 2, 0.001) && near(penv(2)![0][1], 0.5, 0.001));
	// LFO mode per partial: Off, (+), (-), A&L (no controller: no vibrato)
	assert.deepEqual(
		[0, 1, 2, 3].map((m) => patch({ 0x03: m }).tones[0].partials[0].lfoSign),
		[0, 1, -1, 0],
	);
	// PCM partials bypass the TVF, synthesised ones keep it
	const pcm = parseD50SysEx(
		dump(MEM1, [
			partial({ 0x07: 3, 0x2f: 0 }),
			partial(),
			common('S', { 0x0a: 2 }),
			partial(),
			partial(),
			common('L'),
			patchBlock('P'),
		]),
	)[0].patch.tones[0];
	assert.equal(pcm.partials[0].bypassFilter, true);
	assert.equal(pcm.partials[1].bypassFilter, undefined);
});

test('D-50 SysEx: inspectD50Patch warns about the combination waves 77-100 and stays silent otherwise', () => {
	const PCM_PCM = { 0x0a: 5 }; // structure 6: both partials are PCM
	const withWave = (wave: number): Uint8Array =>
		dump(MEM1, [
			partial({ 0x07: wave }),
			partial({ 0x07: 10 }),
			common('Combo', PCM_PCM),
			partial(),
			partial(),
			common('Lower'),
			patchBlock('Combo Patch'),
		]);
	const clean = inspectD50Patch(withWave(30));
	assert.deepEqual(clean, { warnings: [], errors: [] });
	const combo = inspectD50Patch(withWave(79));
	assert.deepEqual(combo.errors, []);
	assert.equal(combo.warnings.length, 1);
	assert.match(combo.warnings[0], /1 of 1 D-50 patches use PCM waves 77-100.*Combo Patch \(wave 80\)/);
	assert.deepEqual(
		inspectD50Patch(new Uint8Array([0xf0, 0x43, 0xf7])),
		{ warnings: [], errors: [] },
		'not D-50 data',
	);
});

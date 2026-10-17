import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	convertToMwa,
	decodeMwa,
	detectFormat,
	encodeMwa,
	encodeMwaUncompressed,
	isMwa,
	loadFile,
	MwaPlayer,
	MwaRecorder,
} from '../src/formats/index.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { Region } from '../src/region.ts';
import { frequency, peak, rms, RATE } from './util.ts';
import { buildYm } from './ymfile.ts';
import { buildVgm } from './vgmfile.ts';
import { buildMod } from './modfile.ts';
import { buildXm, buildIt } from './xmitfile.ts';

const toneRegs = (period: number): number[] => {
	const r = new Array<number>(16).fill(0);
	r[0] = period & 255;
	r[1] = period >> 8;
	r[7] = 0b111110;
	r[8] = 15;
	return r;
};

// ---------------------------------------------------------------- NSF

function buildNsf(opts: { pal?: boolean; code?: number[] }): Uint8Array {
	const h = new Uint8Array(0x80);
	h.set([0x4e, 0x45, 0x53, 0x4d, 0x1a, 1, 1, 1]);
	const v = new DataView(h.buffer);
	v.setUint16(8, 0x8000, true);
	v.setUint16(10, 0x8000, true);
	v.setUint16(12, 0x8001, true);
	v.setUint16(0x6e, 16666, true);
	v.setUint16(0x78, 20000, true);
	h[0x7a] = opts.pal ? 1 : 0;
	// init: RTS; play: once, program pulse 1 (duty 50 %, constant volume 15, period 253)
	const code = opts.code ?? [
		0x60, // $8000 init: RTS
		0xa5,
		0x00,
		0xd0,
		0x16, // $8001 play: LDA $00 ; BNE skip
		0xa9,
		0x01,
		0x8d,
		0x15,
		0x40, // enable pulse 1
		0xa9,
		0xbf,
		0x8d,
		0x00,
		0x40, // $4000 = $BF
		0xa9,
		0xfd,
		0x8d,
		0x02,
		0x40, // $4002 = 253
		0xa9,
		0x00,
		0x8d,
		0x03,
		0x40, // $4003 = 0
		0xe6,
		0x00, // INC $00
		0x60, // skip: RTS
	];
	return Uint8Array.from([...h, ...code]);
}

test('NSF: the 6502 code runs and programs the APU; pitch follows the NTSC clock', () => {
	const bytes = buildNsf({});
	assert.equal(detectFormat(bytes), 'nsf');
	const player = loadFile(bytes, { sampleRate: RATE });
	assert.equal(player.info.region, Region.NTSC);
	const out = renderPlayer(player, { maxSeconds: 1 });
	assert.ok(
		Math.abs(frequency(out.left, RATE, RATE / 4) - 1_789_773 / (16 * 254)) < 0.7,
		`${frequency(out.left, RATE)}`,
	);
});

test('NSF PAL flag selects the PAL APU clock and the PAL play rate', () => {
	const ntsc = renderPlayer(loadFile(buildNsf({}), { sampleRate: RATE }), { maxSeconds: 1 });
	const palPlayer = loadFile(buildNsf({ pal: true }), { sampleRate: RATE });
	assert.equal(palPlayer.info.region, Region.PAL);
	assert.equal(palPlayer.info.frameRate, 50);
	const pal = renderPlayer(palPlayer, { maxSeconds: 1 });
	const ratio = frequency(pal.left, RATE, RATE / 4) / frequency(ntsc.left, RATE, RATE / 4);
	assert.ok(Math.abs(ratio - 1_662_607 / 1_789_773) < 0.003, `ratio ${ratio}`);
});

// ---------------------------------------------------------------- PSID

function buildPsid(pal = true): Uint8Array {
	const h = new Uint8Array(0x7c);
	h.set([0x50, 0x53, 0x49, 0x44]);
	const v = new DataView(h.buffer);
	v.setUint16(4, 2);
	v.setUint16(6, 0x7c);
	v.setUint16(8, 0x1000);
	v.setUint16(10, 0x1000); // init
	v.setUint16(12, 0x1100); // play
	v.setUint16(14, 1);
	v.setUint16(16, 1);
	h.set(
		[...'Test tune'].map((c) => c.charCodeAt(0)),
		0x16,
	);
	v.setUint16(0x76, (pal ? 1 : 2) << 2);
	const freq = Math.round((440 * 16777216) / (pal ? 985248 : 1022727));
	const init = [
		0xa9,
		0x0f,
		0x8d,
		0x18,
		0xd4,
		0xa9,
		0x00,
		0x8d,
		0x05,
		0xd4,
		0xa9,
		0xf0,
		0x8d,
		0x06,
		0xd4,
		0xa9,
		freq & 255,
		0x8d,
		0x00,
		0xd4,
		0xa9,
		freq >> 8,
		0x8d,
		0x01,
		0xd4,
		0xa9,
		0x21,
		0x8d,
		0x04,
		0xd4,
		0x60,
	];
	const body = new Array<number>(0x200).fill(0xea);
	body.splice(0, init.length, ...init);
	body[0x100] = 0x60; // play: RTS
	return Uint8Array.from([...h, ...body]);
}

test('PSID: init routine runs on the 6502 and the SID plays a 440 Hz sawtooth', () => {
	const bytes = buildPsid();
	assert.equal(detectFormat(bytes), 'psid');
	const player = loadFile(bytes, { sampleRate: RATE });
	assert.equal(player.info.title, 'Test tune');
	assert.ok(Math.abs(player.info.frameRate - 50.1245) < 0.01);
	const out = renderPlayer(player, { maxSeconds: 1 });
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 440) < 1, `${frequency(out.left, RATE)}`);
});

test('PSID NTSC flag: 60 Hz frame rate and the NTSC clock', () => {
	const player = loadFile(buildPsid(false), { sampleRate: RATE });
	assert.equal(player.info.region, Region.NTSC);
	assert.ok(Math.abs(player.info.frameRate - 59.826) < 0.01);
	assert.ok(Math.abs(frequency(renderPlayer(player, { maxSeconds: 1 }).left, RATE, RATE / 4) - 440) < 1);
});

// ---------------------------------------------------------------- OPL logs and CMF

const OPL_TONE = [
	[0x01, 0x20],
	[0x23, 0x21],
	[0x43, 0x00],
	[0x63, 0xf0],
	[0x83, 0x0f],
	[0x20, 0x01],
	[0x40, 0x3f],
	[0xc0, 0x01],
	[0xa0, 580 & 255],
	[0xb0, 0x20 | (4 << 2) | (580 >> 8)],
];

test('IMF type 0 and type 1 play OPL writes at the right rate', () => {
	// the delay of a record comes after its write: the last key-on waits 300 ticks, then the key goes off
	const records = [
		...OPL_TONE.flatMap(([r, v], i) => (i === OPL_TONE.length - 1 ? [r, v, 0x2c, 0x01] : [r, v, 0, 0])),
		0xb0,
		4 << 2,
		0,
		0,
	];
	const type0 = Uint8Array.from([0, 0, 0, 0, ...records]); // type 0 starts straight with records (the first is 00 00 00 00)
	const type1 = Uint8Array.from([records.length & 255, records.length >> 8, ...records]);
	for (const bytes of [type0, type1]) {
		assert.equal(detectFormat(bytes, 'song.imf'), 'imf');
		const p = loadFile(bytes, { name: 'song.imf', sampleRate: RATE, imfRate: 700 });
		const out = renderPlayer(p, { maxSeconds: 5 });
		assert.ok(Math.abs(frequency(out.left.subarray(0, RATE * 0.4), RATE, 2000) - 440) < 1);
		assert.ok(out.ended && Math.abs(out.duration - 300 / 700) < 0.05, `duration ${out.duration}`);
	}
});

test('DRO 2.0: codemap, short and long delays', () => {
	const map = [0x01, 0x23, 0x43, 0x63, 0x83, 0x20, 0x40, 0xc0, 0xa0, 0xb0];
	const pairs: number[] = [];
	OPL_TONE.forEach(([, v], i) => pairs.push(i, v));
	pairs.push(100, 255); // short delay code 100: 256 ms
	pairs.push(101, 1); // long delay: 2 * 256 ms
	const h = new Uint8Array(0x1a + map.length);
	h.set([...'DBRAWOPL'].map((c) => c.charCodeAt(0)));
	const v = new DataView(h.buffer);
	v.setUint16(8, 2, true);
	v.setUint32(0x0c, pairs.length / 2, true);
	v.setUint32(0x10, 768, true);
	h[0x14] = 0;
	h[0x17] = 100;
	h[0x18] = 101;
	h[0x19] = map.length;
	h.set(map, 0x1a);
	const bytes = Uint8Array.from([...h, ...pairs]);
	assert.equal(detectFormat(bytes), 'dro');
	const out = renderPlayer(loadFile(bytes, { sampleRate: RATE }), { maxSeconds: 5 });
	assert.ok(Math.abs(out.duration - 0.768) < 0.01, `duration ${out.duration}`);
	assert.ok(Math.abs(frequency(out.left, RATE, 4000) - 440) < 1);
});

test('DRO 0.1: delays, escape and register writes', () => {
	const data = [...OPL_TONE.flatMap(([r, v]) => (r > 4 ? [r, v] : [4, r, v])), 0x00, 0xff];
	const h = new Uint8Array(0x18);
	h.set([...'DBRAWOPL'].map((c) => c.charCodeAt(0)));
	const dv = new DataView(h.buffer);
	dv.setUint16(8, 0, true);
	dv.setUint16(10, 1, true);
	dv.setUint32(0x10, data.length, true);
	const bytes = Uint8Array.from([...h, ...data]);
	const out = renderPlayer(loadFile(bytes, { sampleRate: RATE }), { maxSeconds: 2 });
	assert.ok(Math.abs(out.duration - 0.256) < 0.01, `duration ${out.duration}`);
	assert.ok(peak(out.left) > 0.1);
});

function buildCmf(): Uint8Array {
	const insOffset = 0x28 + 0; // right after the fixed header (instrument count at 0x24, tempo at 0x26)
	const patch = [0x01, 0x21, 0x3f, 0x00, 0xf0, 0xf0, 0x0f, 0x0f, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0];
	const track = [
		0x00,
		0xc0,
		0x00, // program 0
		0x00,
		0x90,
		69,
		127, // note on A4
		0x60,
		0x80,
		69,
		0, // after 96 ticks: note off (one second at 96 ticks per second)
		0x00,
		0xff,
		0x2f,
		0x00,
	];
	const h = new Uint8Array(insOffset);
	h.set([...'CTMF'].map((c) => c.charCodeAt(0)));
	const v = new DataView(h.buffer);
	v.setUint16(4, 0x0101, true);
	v.setUint16(6, insOffset, true);
	v.setUint16(8, insOffset + 16, true);
	v.setUint16(10, 48, true);
	v.setUint16(12, 96, true);
	v.setUint16(0x24, 1, true);
	v.setUint16(0x26, 120, true);
	return Uint8Array.from([...h, ...patch, ...track]);
}

test('CMF: the file instruments are written to the OPL and a MIDI note plays at its pitch', () => {
	const bytes = buildCmf();
	assert.equal(detectFormat(bytes), 'cmf');
	const out = renderPlayer(loadFile(bytes, { sampleRate: RATE }), { maxSeconds: 5 });
	assert.ok(
		Math.abs(frequency(out.left.subarray(0, RATE * 0.9), RATE, 3000) - 440) < 1.5,
		`${frequency(out.left, RATE, 3000)}`,
	);
	assert.ok(out.ended && out.duration > 1 && out.duration < 2);
});

// ---------------------------------------------------------------- detection, MWA

test('format detection by content for every supported format', () => {
	assert.equal(detectFormat(buildYm({ frames: 2, regs: () => toneRegs(100) })), 'ym');
	assert.equal(detectFormat(buildVgm({ sn: 3_579_545, commands: [0x50, 0x80] })), 'vgm');
	assert.equal(detectFormat(buildMod({ patterns: [[[{}]]] })), 'mod');
	assert.equal(detectFormat(buildXm({ rows: [[{}]] })), 'xm');
	assert.equal(detectFormat(buildIt({ rows: [[{}]] })), 'it');
	assert.equal(detectFormat(new Uint8Array(100)), 'unknown');
	assert.throws(() => loadFile(new Uint8Array(100)));
});

test('MWA: a YM converted to MWA plays back bit for bit the same audio', async () => {
	const ym = buildYm({ frames: 60, regs: (f) => toneRegs(100 + f * 3) });
	const direct = renderPlayer(loadFile(ym, { sampleRate: RATE }), { maxSeconds: 5 });
	const mwa = await convertToMwa(ym, {});
	assert.ok(isMwa(mwa));
	assert.ok(mwa.length < ym.length * 2, 'compact');
	const again = renderPlayer(loadFile(mwa, { sampleRate: RATE }), { maxSeconds: 5 });
	assert.equal(again.left.length, direct.left.length);
	assert.deepEqual(again.left, direct.left);
	assert.deepEqual(again.right, direct.right);
});

test('MWA: compressed and uncompressed encodings decode to the same data, the loop point is kept', async () => {
	const ym = buildYm({ frames: 80, regs: () => toneRegs(200), loop: 20 });
	const rec = new MwaRecorder();
	const player = loadFile(ym, { sampleRate: RATE, chipFactory: rec.factory });
	renderPlayer(player, { maxSeconds: 5 });
	const data = rec.finish({ frameRate: 50, title: 'Test', author: 'A', comment: 'C', loopStartSeconds: 0.4 });
	const packed = await encodeMwa(data);
	const plain = encodeMwaUncompressed(data);
	const a = decodeMwa(packed);
	const b = decodeMwa(plain);
	assert.deepEqual(a.time, b.time);
	assert.deepEqual(a.value, b.value);
	assert.equal(a.title, 'Test');
	assert.equal(a.loopStart, Math.round(0.4 * 44100));
	assert.ok(packed.length <= plain.length);
	const looped = renderPlayer(new MwaPlayer(a, { sampleRate: RATE, loop: true }), { maxSeconds: 3 });
	assert.ok(!looped.ended && Math.abs(looped.duration - 3) < 0.01);
	assert.throws(() => decodeMwa(new Uint8Array(20)));
});

test('MWA: a chip with options (AY model) and clocks are stored', async () => {
	const vgm = buildVgm({ ay: 1_773_400, commands: [0xa0, 0, 100, 0xa0, 7, 0x3e, 0xa0, 8, 15, 0x61, 0x10, 0x27] });
	const mwa = await convertToMwa(vgm, {});
	const data = decodeMwa(mwa);
	assert.equal(data.chips[0].id, 'ay8910');
	assert.equal(data.chips[0].clock, 1_773_400);
	const out = renderPlayer(loadFile(mwa, { sampleRate: RATE }), { maxSeconds: 1 });
	assert.ok(Math.abs(frequency(out.left, RATE, 2000) - 1_773_400 / 1600) < 1);
});

test('converting sample based formats is refused with an explanation', async () => {
	await assert.rejects(convertToMwa(buildMod({ patterns: [[[{}]]] })), /no register log/);
	void rms;
});

// ---------------------------------------------------------------- NSF expansion chips

function nsfWithExpansion(bit: number, program: number[]): Uint8Array {
	// the play routine runs every frame: program the chip on the first one only (LDA $00 ; BNE skip ; ... ; INC $00)
	const once = [0xa5, 0x00, 0xd0, program.length + 2, ...program, 0xe6, 0x00];
	const base = buildNsf({ code: [0x60, ...once, 0x60] });
	base[0x7b] = bit;
	return base;
}

test('NSF expansion audio: VRC6 pulse, MMC5 pulse and Sunsoft 5B play at their own pitch', () => {
	// VRC6 pulse 1 at period 253 (volume 15, constant), sawtooth off
	const vrc6 = nsfWithExpansion(
		1,
		[0xa9, 0x7f, 0x8d, 0x00, 0x90, 0xa9, 0xfd, 0x8d, 0x01, 0x90, 0xa9, 0x80, 0x8d, 0x02, 0x90],
	);
	const pv = loadFile(vrc6, { sampleRate: RATE });
	assert.ok(pv.chips.some((c) => c.id === 'vrc6'));
	const fv = frequency(renderPlayer(pv, { maxSeconds: 1 }).left, RATE, RATE / 4);
	assert.ok(Math.abs(fv - 1_789_773 / (16 * 254)) < 1, `VRC6 ${fv}`);
	// MMC5 pulse 1 ($5000 constant volume 15 duty 50 %, $5002 / $5003 period, $5015 enable)
	const mmc5 = nsfWithExpansion(
		8,
		[
			0xa9, 0x03, 0x8d, 0x15, 0x50, 0xa9, 0xbf, 0x8d, 0x00, 0x50, 0xa9, 0xfd, 0x8d, 0x02, 0x50, 0xa9, 0x08, 0x8d,
			0x03, 0x50,
		],
	);
	const pm = loadFile(mmc5, { sampleRate: RATE });
	assert.ok(pm.chips.some((c) => c.id === 'mmc5'));
	const fm = frequency(renderPlayer(pm, { maxSeconds: 1 }).left, RATE, RATE / 4);
	assert.ok(Math.abs(fm - 1_789_773 / (16 * 254)) < 2, `MMC5 ${fm}`);
	// Sunsoft 5B: tone A period 200 at AY clock = CPU / 2 (registers through $C000 / $E000)
	const w = (reg: number, val: number): number[] => [0xa9, reg, 0x8d, 0x00, 0xc0, 0xa9, val, 0x8d, 0x00, 0xe0];
	const s5b = nsfWithExpansion(32, [...w(0, 200), ...w(7, 0x3e), ...w(8, 15)]);
	const p5 = loadFile(s5b, { sampleRate: RATE });
	assert.ok(p5.chips.some((c) => c.id === 'sunsoft5b'));
	const f5 = frequency(renderPlayer(p5, { maxSeconds: 1 }).left, RATE, RATE / 4);
	assert.ok(Math.abs(f5 - 1_789_773 / 2 / (16 * 200)) < 1, `5B ${f5}`);
});

test('NSF expansion audio: Namco 163 and FDS play at the pitch their registers dictate', () => {
	const sta = (addr: number, v: number): number[] => [0xa9, v, 0x8d, addr & 255, addr >> 8];
	// Namco 163: one channel (count nibble 0), a 32 sample square wave, frequency 0x1000, volume 15
	const ram: number[] = [];
	const setAddr = (a: number): number[] => sta(0xf800, a | 0x80);
	const wave = Array.from({ length: 16 }, (_, i) => (i < 8 ? 0xff : 0x00)); // 32 4-bit samples: 16 high, 16 low... as bytes
	for (const b of wave) ram.push(...sta(0x4800, b));
	const regs: number[] = [
		...setAddr(0x78),
		...sta(0x4800, 0x00), // frequency low
		...sta(0x4800, 0x00),
		...sta(0x4800, 0x10), // frequency mid
		...sta(0x4800, 0x00),
		...sta(0x4800, 0xe0 | 0), // wave length 256 - 0xe0 = 32, frequency high 0
		...sta(0x4800, 0x00),
		...sta(0x4800, 0x00), // wave address 0
		...sta(0x4800, 0x0f), // volume 15, one channel
	];
	const n163 = nsfWithExpansion(16, [...setAddr(0), ...ram, ...regs]);
	const p = loadFile(n163, { sampleRate: RATE });
	assert.ok(p.chips.some((c) => c.id === 'namco163'));
	const f = frequency(renderPlayer(p, { maxSeconds: 1 }).left, RATE, RATE / 4);
	const expected = (1_789_773 * 0x1000) / (15 * 1 * 32 * 65536);
	assert.ok(Math.abs(f - expected) < 2, `N163 ${f} vs ${expected}`);
	// FDS: flat wave of 64 samples at level 63 would be silent AC-wise, so write a square; master volume full, gain 32
	const fds: number[] = [...sta(0x4089, 0x80)];
	for (let i = 0; i < 64; i++) fds.push(...sta(0x4040 + i, i < 32 ? 63 : 0));
	fds.push(
		...sta(0x4089, 0x00),
		...sta(0x4080, 0x80 | 32),
		...sta(0x4082, 0x00),
		...sta(0x4083, 0x04),
		...sta(0x4087, 0x80),
	);
	const pf = loadFile(nsfWithExpansion(4, fds), { sampleRate: RATE });
	assert.ok(pf.chips.some((c) => c.id === 'fds'));
	const ff = frequency(renderPlayer(pf, { maxSeconds: 1 }).left, RATE, RATE / 4);
	const expectedF = (1_789_773 * 0x400) / 2 ** 22;
	assert.ok(Math.abs(ff - expectedF) < 2, `FDS ${ff} vs ${expectedF}`);
});

test('Creative ADPCM (4, 2.6 and 2 bit VOC codecs) follows a smooth tone through the step adaptation', async () => {
	const { decodeCreativeAdpcm } = await import('../src/formats/pcm.ts');
	// encoder written from the decoder's definition: pick the code whose decoded value is closest, then follow its state
	const encode = (samples: number[], bits: 4 | 3 | 2): number[] => {
		const cfg = {
			4: { maxIndex: 3, sign: 8, steps: [0x100, 0x200, 0x400, 0x800], changes: [-1, 0, 0, 0, 0, 1, 1, 1] },
			3: { maxIndex: 4, sign: 4, steps: [0x100, 0x200, 0x400, 0x800, 0xa00], changes: [-1, 0, 0, 1] },
			2: { maxIndex: 5, sign: 2, steps: [0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000], changes: [-1, 1] },
		}[bits];
		let last = (samples[0] - 128) << 8;
		let index = 0;
		const codes: number[] = [];
		for (let i = 1; i < samples.length; i++) {
			const target = (samples[i] - 128) << 8;
			let best = 0;
			let bestErr = Infinity;
			let bestState = { last, index };
			for (let code = 0; code < cfg.sign * 2; code++) {
				// the third code of a 3 bit byte only has 2 bits: its low magnitude bit does not exist
				if (bits === 3 && (i - 1) % 3 === 2 && code & 1) continue;
				let v = ((code & (cfg.sign - 1)) << 1) | 1;
				v = ((cfg.steps[index] * v) >> 1) & ~255;
				if (code & cfg.sign) v = -v;
				const l = Math.max(-32768, Math.min(32767, last + v));
				const err = Math.abs(l - target);
				if (err < bestErr) {
					bestErr = err;
					best = code;
					bestState = {
						last: l,
						index: Math.max(0, Math.min(cfg.maxIndex, index + cfg.changes[code & (cfg.sign - 1)])),
					};
				}
			}
			codes.push(best);
			({ last, index } = bestState);
		}
		return codes;
	};
	const tone = Array.from({ length: 400 }, (_, i) => Math.round(128 + 100 * Math.sin(i / 12)));
	for (const bits of [4, 3, 2] as const) {
		const codes = encode(tone, bits);
		const bytes: number[] = [tone[0]];
		const per = bits === 4 ? 2 : bits === 3 ? 3 : 4;
		for (let i = 0; i < codes.length; i += per) {
			const c = (k: number): number => codes[i + k] ?? 0;
			if (bits === 4) bytes.push(((c(0) & 15) << 4) | (c(1) & 15));
			else if (bits === 3) bytes.push(((c(0) & 7) << 5) | ((c(1) & 7) << 2) | ((c(2) & 7) >> 1));
			else bytes.push(((c(0) & 3) << 6) | ((c(1) & 3) << 4) | ((c(2) & 3) << 2) | (c(3) & 3));
		}
		const out = decodeCreativeAdpcm(Uint8Array.from(bytes), bits);
		let err = 0;
		let energy = 0;
		for (let i = 20; i < tone.length; i++) {
			const ref = (tone[i] - 128) / 128;
			err += (out[i] - ref) ** 2;
			energy += ref ** 2;
		}
		const limit = bits === 4 ? 0.05 : bits === 3 ? 0.5 : 0.5;
		assert.ok(err / energy < limit, `${bits} bit: relative error ${err / energy}`);
	}
});

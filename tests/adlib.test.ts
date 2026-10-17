import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, loadFile } from '../src/formats/index.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { frequency, peak, RATE } from './util.ts';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

// ---------------------------------------------------------------- HSC

function buildHsc(): Uint8Array {
	const out = new Uint8Array(1587 + 1152);
	// instrument 0: carrier char 0x21, modulator char 0x01, carrier TL 0, modulator TL 63 (silent), AD F0 / F0, SR 0F / 0F,
	// additive connection, plain sine waves, no slide
	out.set([0x21, 0x01, 0x00, 0x3f, 0xf0, 0xf0, 0x0f, 0x0f, 0x01, 0x00, 0x00, 0x00], 0);
	out[1536] = 0; // order: pattern 0
	out[1537] = 0xff;
	// pattern 0 row 0 channel 0: note 58 = octave 4, note A (index 9): fnum 611
	out[1587] = 58;
	return out;
}

test('HSC: the 18.2 Hz replayer writes the instrument and the note to the OPL', () => {
	const bytes = buildHsc();
	assert.equal(detectFormat(bytes, 'song.hsc'), 'hsc');
	assert.equal(detectFormat(bytes, 'song.bin'), 'unknown');
	const p = loadFile(bytes, { name: 'song.hsc', sampleRate: RATE });
	const out = renderPlayer(p, { maxSeconds: 20 });
	const expected = (611 * 3_579_545) / 72 / 2 ** 16; // fnum 611 at octave 4
	assert.ok(
		Math.abs(frequency(out.left, RATE, RATE / 2) - expected) < 1,
		`${frequency(out.left, RATE)} vs ${expected}`,
	);
	// 64 rows at speed 2 on an 18.2 Hz timer
	assert.ok(out.ended && Math.abs(out.duration - 128 / 18.2) < 1, `duration ${out.duration}`);
	assert.ok(peak(out.left) > 0.1);
});

// ---------------------------------------------------------------- RAD 2.1

function buildRad(): Uint8Array {
	const instrument = [
		1, // instrument number
		0, // name length
		0, // algorithm 0 (2 operators FM), panning bits 0, no riff
		0x00, // feedback 0 / 0
		0x00, // detune 0, riff speed 0
		64, // volume
		0x21,
		0x00,
		0xf0,
		0x0f,
		0x00, // operator 0 (the carrier): chars, volume (0 = loudest), AD, SR, wave
		0x01,
		0x3f,
		0xf0,
		0x0f,
		0x00, // operator 1 (the modulator): silent
		0,
		0,
		0,
		0,
		0, // operator 2 (unused for 2-op)
		0,
		0,
		0,
		0,
		0, // operator 3
	];
	// track 0: one line (line 0, last line) with one channel (channel 0, last, note, instrument): A in octave 4
	const track = [0x80 | 0, 0x80 | 0x40 | 0x20 | 0, (4 << 4) | 9, 1];
	return Uint8Array.from([
		...ascii('RAD by REALiTY!!'),
		0x21, // version 2.1
		6, // flags: speed 6, tempo 50 Hz
		0, // empty description
		...instrument,
		0, // end of instruments
		1,
		0, // order list: 1 entry, pattern 0
		0,
		track.length & 255,
		track.length >> 8,
		...track, // track 0
		0xff, // end of tracks
		0xff, // end of riffs
	]);
}

test('RAD 2.1: instrument, note, order list and the OPL3 log', () => {
	const bytes = buildRad();
	assert.equal(detectFormat(bytes), 'rad');
	const p = loadFile(bytes, { sampleRate: RATE });
	assert.deepEqual(p.info.chips, ['opl3']);
	const out = renderPlayer(p, { maxSeconds: 20 });
	// RAD's A in octave 4 is fnum 0x241 (577): 577 * 49716 / 2^16 = 437.7 Hz
	const expected = (577 * 14_318_180) / 288 / 2 ** 16;
	assert.ok(
		Math.abs(frequency(out.left, RATE, RATE / 2) - expected) < 1,
		`${frequency(out.left, RATE)} vs ${expected}`,
	);
	assert.ok(peak(out.left) > 0.1);
	// the tune is 64 lines of 6 ticks at 50 Hz = 7.68 s before the order list repeats
	assert.ok(out.ended && Math.abs(out.duration - 7.68) < 0.1, `duration ${out.duration}`);
});

// ---------------------------------------------------------------- D00 (EdLib), version 2

function buildD00(): Uint8Array {
	const out = new Uint8Array(0xbb);
	const v = new DataView(out.buffer);
	out.set([0x4a, 0x43, 0x48, 0x26, 0x02, 0x66], 0);
	out[6] = 0; // type
	out[7] = 2; // version
	out[8] = 70; // 70 Hz
	out[9] = 1; // sub-songs
	out.set(ascii('Test tune'), 11);
	out.set(ascii('Composer'), 43);
	v.setUint16(107, 0x77, true); // track pointers
	v.setUint16(109, 0x97, true); // sequence pointers
	v.setUint16(111, 0x9f, true); // instruments
	v.setUint16(113, 0xaf, true); // info
	v.setUint16(115, 0xb7, true); // level pulses
	v.setUint16(0x77, 0xb1, true); // sub-song 0, channel 0: track at 0xb1; the other channels are off, volume 0 = full
	// sequence table and pattern
	v.setUint16(0x97, 0x99, true);
	v.setUint16(0x99, 0xc000, true); // effect C: set instrument 0
	v.setUint16(0x9b, (0x10 << 8) | 0x39, true); // note 57 (octave 4, note A), held 16 ticks
	v.setUint16(0x9d, 0xffff, true); // end of pattern
	// instrument 0
	out.set([0xf0, 0x0f, 0x00, 0x21, 0x00, 0xf0, 0x0f, 0x3f, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0], 0x9f);
	// the track of channel 0: speed 1, order list: sequence 0, end
	v.setUint16(0xb1, 1, true);
	v.setUint16(0xb3, 0, true);
	v.setUint16(0xb5, 0xfffe, true);
	return out;
}

test('D00 version 2: orders, sequences, instruments and the 70 Hz timer', () => {
	const bytes = buildD00();
	assert.equal(detectFormat(bytes, 'tune.d00'), 'd00');
	const p = loadFile(bytes, { name: 'tune.d00', sampleRate: RATE });
	assert.equal(p.info.title, 'Test tune');
	assert.equal(p.info.author, 'Composer');
	const out = renderPlayer(p, { maxSeconds: 10 });
	const expected = (577 * 3_579_545) / 72 / 2 ** 16;
	assert.ok(
		Math.abs(frequency(out.left, RATE, 2000) - expected) < 1.5,
		`${frequency(out.left, RATE)} vs ${expected}`,
	);
	assert.ok(out.ended && out.duration < 2, `duration ${out.duration}`);
	assert.ok(peak(out.left) > 0.1);
});

// ---------------------------------------------------------------- ROL + BNK (Visual Composer)

function buildBnk(): Uint8Array {
	const out = new Uint8Array(32 + 30);
	const v = new DataView(out.buffer);
	out[0] = 1;
	out[1] = 0;
	out.set(ascii('ADLIB-'), 2);
	v.setUint16(8, 1, true);
	v.setUint16(10, 1, true);
	v.setInt32(12, 20, true);
	v.setInt32(16, 32, true);
	// name list entry: index 0, used, "PIANO"
	out[22] = 1;
	out.set(ascii('PIANO'), 23);
	// record: mode, voice number, modulator (silent), carrier (loud, sustained), waveforms
	const mod = [0, 1, 0, 15, 0, 1, 0, 15, 63, 0, 0, 0, 1];
	const car = [0, 1, 0, 15, 0, 1, 0, 15, 0, 0, 0, 0, 1];
	out.set([0, 0, ...mod, ...car, 0, 0], 32);
	return out;
}

function buildRol(): Uint8Array {
	const bytes: number[] = [];
	const u16 = (n: number): void => void bytes.push(n & 255, (n >> 8) & 255);
	const f32 = (x: number): void => void bytes.push(...new Uint8Array(new Float32Array([x]).buffer));
	u16(0);
	u16(4);
	bytes.push(...ascii('Test song').concat(new Array(31).fill(0)));
	u16(48); // ticks per beat
	u16(4);
	u16(0);
	u16(0);
	bytes.push(0); // unused
	bytes.push(1); // melodic mode
	bytes.push(...new Array(90 + 38 + 15).fill(0));
	f32(120); // basic tempo
	u16(0); // tempo events
	for (let voice = 0; voice < 9; voice++) {
		bytes.push(...new Array(15).fill(0));
		if (voice === 0) {
			u16(96); // time of last note
			u16(69); // note: octave 4, A
			u16(96); // duration
		} else u16(0);
		bytes.push(...new Array(15).fill(0));
		if (voice === 0) {
			u16(1);
			u16(0);
			bytes.push(...ascii('PIANO'), 0, 0, 0, 0, 0, 0, 0);
		} else u16(0);
		bytes.push(...new Array(15).fill(0));
		u16(0); // volume events
		bytes.push(...new Array(15).fill(0));
		u16(0); // pitch events
	}
	return Uint8Array.from(bytes);
}

test('ROL + BNK: instruments are looked up by name, notes play on the OPL2 at the Composer pitch', () => {
	const rol = buildRol();
	assert.equal(detectFormat(rol, 'tune.rol'), 'rol');
	assert.throws(() => loadFile(rol, { name: 'tune.rol', sampleRate: RATE }), /needs its .bnk/);
	const p = loadFile(rol, { name: 'tune.rol', sampleRate: RATE, bank: buildBnk() });
	assert.equal(p.info.title, 'Test song');
	const out = renderPlayer(p, { maxSeconds: 10 });
	const expected = (579 * 3_579_545) / 72 / 2 ** 16; // fnum 579 at octave 4
	assert.ok(
		Math.abs(frequency(out.left, RATE, RATE / 4) - expected) < 1,
		`${frequency(out.left, RATE)} vs ${expected}`,
	);
	assert.ok(out.ended && out.duration > 0.9 && out.duration < 2.5, `duration ${out.duration}`);
	assert.ok(peak(out.left) > 0.1);
});

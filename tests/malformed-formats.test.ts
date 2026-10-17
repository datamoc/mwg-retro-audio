import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseD00 } from '../src/formats/d00.ts';
import { parseRad } from '../src/formats/rad.ts';

/** a small valid RAD 2.1 tune: one instrument, one order, one track with one note, then the table terminators */
function radFile(): Uint8Array {
	const bytes: number[] = [...'RAD by REALiTY!!'].map((c) => c.charCodeAt(0));
	bytes.push(0x21, 0x06, 0); // version, flags (speed 6), empty description
	bytes.push(1, 0, 0, 0, 0, 0, ...new Array(20).fill(0)); // instrument 1: no name, algorithm 0, volume 0, operators
	bytes.push(0); // end of the instruments
	bytes.push(1, 0); // order list: one entry, track 0
	bytes.push(0, 3, 0, 0x80, 0xc0, 0x31); // track 0: line 0 (last), channel 0 with a note
	bytes.push(100); // end of the tracks
	bytes.push(0xa0); // end of the riffs
	return Uint8Array.from(bytes);
}

/** a deterministic pseudo-random generator, so a failure can be replayed */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

/** run a parser on hostile input: an error is fine, an endless loop or a very slow run is not */
function bounded(label: string, run: () => unknown, limitMs = 1500): void {
	const start = performance.now();
	try {
		run();
	} catch (error) {
		assert(error instanceof Error, `${label}: thrown value is not an Error`);
	}
	const elapsed = performance.now() - start;
	assert(elapsed < limitMs, `${label} took ${Math.round(elapsed)} ms`);
}

test('the reference RAD tune parses', () => {
	const data = parseRad(radFile(), { maxSeconds: 1 });
	assert(data.length > 0);
});

test('a RAD tune cut at any length is parsed or rejected, never looped on', () => {
	const file = radFile();
	for (let length = 18; length < file.length; length++)
		bounded(`RAD cut at ${length}`, () => parseRad(file.subarray(0, length), { maxSeconds: 1 }));
});

test('a RAD track without its end marker does not hang the player', () => {
	const file = radFile().subarray(0, 0x11 + 2 + 1 + 26 + 1 + 2 + 3 + 2);
	bounded('RAD open track', () => parseRad(file, { maxSeconds: 1 }));
});

test('a RAD tune with an instrument table that never ends is rejected', () => {
	const bytes = radFile();
	const open = Uint8Array.from([...bytes.subarray(0, 0x14), ...new Array(40).fill(1)]);
	assert.throws(() => parseRad(open, { maxSeconds: 1 }), RangeError);
});

test('a RAD tune with random damage never hangs', () => {
	const next = random(12345);
	const file = radFile();
	for (let round = 0; round < 400; round++) {
		const copy = Uint8Array.from(file);
		for (let hits = 1 + Math.floor(next() * 3); hits > 0; hits--)
			copy[0x11 + Math.floor(next() * (copy.length - 0x11))] = Math.floor(next() * 256);
		bounded(`RAD damage round ${round}`, () => parseRad(copy, { maxSeconds: 1 }));
	}
});

/** a D00 (version 1 header): channel 0 plays a long run of notes, the eight others loop on an order jump to themselves */
function d00WithJumpLoops(): Uint8Array {
	const tpoin = 0x10;
	const seqptr = 0x40;
	const instptr = 0x60;
	const lists = 0x80; // order lists: the playing one, then the looping one
	const playing = lists;
	const looping = lists + 0x10;
	const patterns = 0xc0;
	const notes = 3000;
	const file = new Uint8Array(patterns + notes * 2 + 4);
	const put = (offset: number, value: number): void => {
		file[offset] = value & 255;
		file[offset + 1] = value >> 8;
	};
	file[0] = 1; // version
	file[1] = 70; // speed in Hz
	file[2] = 1; // one subsong
	put(3, tpoin);
	put(5, seqptr);
	put(7, instptr);
	for (let channel = 0; channel < 9; channel++) put(tpoin + channel * 2, channel === 0 ? playing : looping);
	put(playing, 1); // speed
	put(playing + 2, 0); // order: pattern 0
	put(playing + 4, 0xfffe); // end of the song
	put(looping, 1);
	put(looping + 2, 0xffff); // jump...
	put(looping + 4, 0); // ...to order position 0, which is this jump again
	put(seqptr, patterns); // pattern 0
	for (let note = 0; note < notes; note++) put(patterns + note * 2, 0x3f30); // 63 ticks per note
	put(patterns + notes * 2, 0xffff);
	return file;
}

test('D00 order jumps that loop back on themselves end the channel instead of spinning every tick', () => {
	bounded('D00 jump loops', () => assert(parseD00(d00WithJumpLoops(), { maxSeconds: 900 }).length > 0), 1500);
});

test('a D00 file that declares a zero speed is rejected', () => {
	const file = d00WithJumpLoops();
	file[1] = 0;
	assert.throws(() => parseD00(file), /speed/);
});

test('a D00 file with random damage never hangs', () => {
	const next = random(777);
	const file = d00WithJumpLoops();
	for (let round = 0; round < 60; round++) {
		const copy = Uint8Array.from(file);
		for (let hits = 1 + Math.floor(next() * 4); hits > 0; hits--)
			copy[3 + Math.floor(next() * 0xd0)] = Math.floor(next() * 256);
		bounded(`D00 damage round ${round}`, () => parseD00(copy, { maxSeconds: 60 }), 3000);
	}
});

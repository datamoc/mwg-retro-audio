import type { MwaData } from './mwa.ts';
import { EventLog } from './opl-logs.ts';

/**
 * SPDX-License-Identifier: LGPL-2.1-or-later (behaviour of the free AdPlug replayer, see NOTICE)
 *
 * HSC-Tracker / HSC Adlib Composer (`.hsc`): 128 instruments of 12 bytes, a 51 entry order list and 64 row x 9 channel
 * patterns of two bytes (note, effect), played by an interrupt at 18.2 Hz. There is no signature: the size
 * (1587 + 1152 * patterns, optionally one trailing byte) and the extension identify it.
 *
 * The player of the original tracker is run for the whole song and the OPL2 register writes it makes are recorded as
 * timed events (`MwaData`), which `MwaPlayer` then plays like any other OPL log.
 *
 * Note: written from the published behaviour of the format (instrument layout, order jumps, slides, fade-in, 6 voice
 * percussion mode); no HSC file from a real tracker was available to compare with.
 */

const NOTE_TABLE = [363, 385, 408, 432, 458, 485, 514, 544, 577, 611, 647, 686];
const OP_TABLE = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];
const TIMEBASE = 44100;
const OPL_CLOCK = 3_579_545;
const REFRESH_HZ = 18.2;

export function looksLikeHsc(b: Uint8Array): boolean {
	return b.length >= 1587 + 1152 && b.length <= 59187 + 1 && (b.length - 1587) % 1152 <= 1;
}

export function parseHsc(b: Uint8Array): MwaData {
	if (!looksLikeHsc(b)) throw new Error('not an HSC file (size does not fit the layout)');
	const patternsInFile = Math.floor((b.length - 1587) / 1152);
	const instr = Array.from({ length: 128 }, (_, i) => Uint8Array.from(b.subarray(i * 12, i * 12 + 12)));
	for (const ins of instr) {
		ins[2] ^= (ins[2] & 0x40) << 1;
		ins[3] ^= (ins[3] & 0x40) << 1;
		ins[11] >>= 4; // slide
	}
	const song = new Uint8Array(0x80).fill(0xff);
	for (let i = 0; i < 51; i++) {
		const v = b[1536 + i];
		song[i] = (v & 0x7f) > 0x31 || (v & 0x7f) >= patternsInFile ? 0xff : v;
	}
	const patterns = (n: number, row: number, ch: number): [number, number] => {
		const o = 1587 + (n * 64 + row) * 18 + ch * 2;
		return [b[o] ?? 0, b[o + 1] ?? 0];
	};

	const log = new EventLog();
	const w = (reg: number, value: number): void => log.push(0, reg, value);
	const channel = Array.from({ length: 9 }, () => ({ inst: 0, slide: 0, freq: 0 }));
	const adlFreq = new Uint8Array(9);
	let pattpos = 0;
	let songpos = 0;
	let pattbreak = 0;
	let songend = false;
	let mode6 = false;
	let bd = 0;
	let fadein = 0;
	let speed = 2;
	let del = 1;

	const setfreq = (chan: number, freq: number): void => {
		adlFreq[chan] = (adlFreq[chan] & ~3) | ((freq >> 8) & 3);
		w(0xa0 + chan, freq & 0xff);
		w(0xb0 + chan, adlFreq[chan]);
	};
	const setvolume = (chan: number, volc: number, volm: number): void => {
		const ins = instr[channel[chan].inst];
		const op = OP_TABLE[chan];
		w(0x43 + op, volc | (ins[2] & ~63));
		if (ins[8] & 1) w(0x40 + op, volm | (ins[3] & ~63));
		else w(0x40 + op, ins[3]);
	};
	const setinstr = (chan: number, insnr: number): void => {
		const ins = instr[insnr & 127];
		const op = OP_TABLE[chan];
		channel[chan].inst = insnr & 127;
		w(0xb0 + chan, 0);
		w(0xc0 + chan, ins[8]);
		w(0x23 + op, ins[0]);
		w(0x20 + op, ins[1]);
		w(0x63 + op, ins[4]);
		w(0x60 + op, ins[5]);
		w(0x83 + op, ins[6]);
		w(0x80 + op, ins[7]);
		w(0xe3 + op, ins[9]);
		w(0xe0 + op, ins[10]);
		setvolume(chan, ins[2] & 63, ins[3] & 63);
	};

	w(1, 32);
	w(8, 128);
	w(0xbd, 0);
	for (let i = 0; i < 9; i++) setinstr(i, i);

	const tickSeconds = 1 / REFRESH_HZ;
	let ticks = 0;
	const maxTicks = Math.ceil(30 * 60 * REFRESH_HZ); // a song that never ends is cut after half an hour
	while (!songend && ticks < maxTicks) {
		log.time = ticks * tickSeconds * TIMEBASE;
		ticks++;
		if (--del !== 0) continue;
		if (fadein) fadein--;
		let pattnr = song[songpos];
		if (pattnr >= 0xb2) {
			songend = true;
			songpos = 0;
			pattnr = song[songpos];
		} else if (pattnr & 128 && pattnr <= 0xb1) {
			songpos = song[songpos] & 127;
			pattpos = 0;
			pattnr = song[songpos];
			songend = true;
		}
		if (pattnr < 50) {
			for (let chan = 0; chan < 9; chan++) {
				let [note, effect] = patterns(pattnr, pattpos, chan);
				void effect;
				if (note & 128) {
					setinstr(chan, effect);
					continue;
				}
				const effOp = effect & 0x0f;
				const inst = channel[chan].inst;
				if (note) channel[chan].slide = 0;
				switch (effect & 0xf0) {
					case 0:
						if (effOp === 1) pattbreak++;
						else if (effOp === 3) fadein = 31;
						else if (effOp === 5) mode6 = true;
						else if (effOp === 6) mode6 = false;
						break;
					case 0x10:
					case 0x20:
						if (effect & 0x10) {
							channel[chan].freq += effOp;
							channel[chan].slide += effOp;
						} else {
							channel[chan].freq -= effOp;
							channel[chan].slide -= effOp;
						}
						if (!note) setfreq(chan, channel[chan].freq);
						break;
					case 0x60:
						w(0xc0 + chan, (instr[inst][8] & 1) + (effOp << 1));
						break;
					case 0xa0:
						w(0x43 + OP_TABLE[chan], (effOp << 2) | (instr[inst][2] & ~63));
						break;
					case 0xb0:
						w(0x40 + OP_TABLE[chan], (effOp << 2) | (instr[inst][3] & ~63));
						break;
					case 0xc0: {
						const db = effOp << 2;
						w(0x43 + OP_TABLE[chan], db | (instr[inst][2] & ~63));
						if (instr[inst][8] & 1) w(0x40 + OP_TABLE[chan], db | (instr[inst][3] & ~63));
						break;
					}
					case 0xd0:
						pattbreak++;
						songpos = effOp;
						songend = true;
						break;
					case 0xf0:
						speed = effOp + 1;
						del = speed;
						break;
				}
				if (fadein) setvolume(chan, fadein * 2, fadein * 2);
				if (!note) continue;
				note--;
				if (note === 0x7f - 1 || (note / 12) & ~7 || Math.floor(note / 12) > 7) {
					adlFreq[chan] &= ~32;
					w(0xb0 + chan, adlFreq[chan]);
					continue;
				}
				const okt = (Math.floor(note / 12) & 7) << 2;
				const fnr = NOTE_TABLE[note % 12] + instr[inst][11] + channel[chan].slide;
				channel[chan].freq = fnr;
				adlFreq[chan] = !mode6 || chan < 6 ? okt | 32 : okt;
				w(0xb0 + chan, 0);
				setfreq(chan, fnr);
				if (mode6) {
					if (chan === 6) {
						w(0xbd, bd & ~16);
						bd |= 48;
					} else if (chan === 7) {
						w(0xbd, bd & ~1);
						bd |= 33;
					} else if (chan === 8) {
						w(0xbd, bd & ~2);
						bd |= 34;
					}
					w(0xbd, bd);
				}
			}
		}
		del = speed;
		if (pattbreak) {
			pattpos = 0;
			pattbreak = 0;
			songpos = (songpos + 1) % 50;
			if (!songpos) songend = true;
		} else {
			pattpos = (pattpos + 1) & 63;
			if (!pattpos) {
				songpos = (songpos + 1) % 50;
				if (!songpos) songend = true;
			}
		}
	}
	log.time = ticks * tickSeconds * TIMEBASE + 0.5 * TIMEBASE;
	return log.build([{ id: 'opl2', clock: OPL_CLOCK }], REFRESH_HZ, 'HSC-Tracker');
}

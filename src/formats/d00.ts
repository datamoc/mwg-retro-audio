import type { MwaData } from './mwa.ts';
import { EventLog } from './opl-logs.ts';

/**
 * SPDX-License-Identifier: LGPL-2.1-or-later (behaviour of the free AdPlug replayer, see NOTICE)
 *
 * EdLib packed modules (`.d00`, versions 0 to 4): nine tracks of orders, sequences, instruments, special effects
 * (SpFX, versions 2-4) and level pulses (LevelPuls, version 1-2), played on the OPL2 by a timer between 70 and 100 Hz.
 * The replayer is run for the whole sub-song and its register writes are recorded as timed events (`MwaData`).
 *
 * Written from the behaviour of the format as implemented by the free replayers (note table, event coding, effect
 * semantics, hard restart of version 4). No D00 file produced by EdLib was available to compare with.
 */

const NOTE_TABLE = [340, 363, 385, 408, 432, 458, 485, 514, 544, 577, 611, 647];
const OP_TABLE = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];
const TIMEBASE = 44100;
const OPL_CLOCK = 3_579_545;
const ID = [0x4a, 0x43, 0x48, 0x26, 0x02, 0x66];

export function isD00(b: Uint8Array, name = ''): boolean {
	const ext = name.toLowerCase().endsWith('.d00');
	if (
		b.length > 0x77 &&
		ID.every((v, i) => b[i] === v) &&
		b[7] >= 2 &&
		b[7] <= 4 &&
		b[9] > 0 &&
		b[10] === 0 &&
		b[6] === 0
	)
		return true;
	if (ID.every((v, i) => b[i] === v) && b[7] & 0x80) return ext;
	return ext && b.length > 15 && b[0] <= 1 && b[2] > 0;
}

interface Chan {
	order: number; // offset of the order list or -1
	ordpos: number;
	pattpos: number;
	del: number;
	speed: number;
	rhcnt: number;
	key: number;
	freq: number;
	inst: number;
	spfx: number;
	ispfx: number;
	irhcnt: number;
	transpose: number;
	slide: number;
	slideval: number;
	vibspeed: number;
	seqend: number;
	vol: number;
	vibdepth: number;
	fxdel: number;
	modvol: number;
	cvol: number;
	levpuls: number;
	frameskip: number;
	nextnote: number;
	note: number;
	ilevpuls: number;
	trigger: number;
	fxflag: number;
}

const newChan = (): Chan => ({
	order: -1,
	ordpos: 0,
	pattpos: 0,
	del: 0,
	speed: 0,
	rhcnt: 0,
	key: 0,
	freq: 0,
	inst: 0,
	spfx: 0,
	ispfx: 0xffff,
	irhcnt: 0,
	transpose: 0,
	slide: 0,
	slideval: 0,
	vibspeed: 0,
	seqend: 0,
	vol: 0,
	vibdepth: 0,
	fxdel: 0,
	modvol: 0,
	cvol: 0,
	levpuls: 0xff,
	frameskip: 0,
	nextnote: 0,
	note: 0,
	ilevpuls: 0xff,
	trigger: 0,
	fxflag: 0,
});

const s16 = (v: number): number => (v << 16) >> 16;
const u16 = (v: number): number => v & 0xffff;
const u8 = (v: number): number => v & 0xff;

/** Run a D00 module (one sub-song) and return its OPL2 register log */
export function parseD00(file: Uint8Array, options: { subsong?: number; maxSeconds?: number } = {}): MwaData {
	if (file.length < 16) throw new Error('not a D00 file');
	let headerStart = 0;
	let ver1 = false;
	const hasId = ID.every((v, i) => file[i] === v);
	if (hasId && file[7] & 0x80) {
		headerStart = 0x6b;
		ver1 = true;
	} else if (!hasId || file[6] !== 0 || file[9] === 0 || file[10] !== 0 || file[7] < 2 || file[7] > 4) ver1 = true;
	const d = new Uint8Array(file.length - headerStart + 1);
	d.set(file.subarray(headerStart));
	const size = file.length - headerStart;
	const w16 = (o: number): number => (o >= 0 && o + 1 < d.length ? d[o] | (d[o + 1] << 8) : 0);

	let version: number;
	let speedHz: number;
	let subsongs: number;
	let tpoin: number;
	let seqptr: number;
	let instptr: number;
	let infoptr: number;
	let extraPtr: number;
	let title = '';
	let author = '';
	if (!ver1) {
		version = d[7];
		speedHz = d[8];
		subsongs = d[9];
		const text = (o: number): string =>
			String.fromCharCode(...d.subarray(o, o + 31))
				.replace(/\0.*$/, '')
				.trimEnd();
		title = text(11);
		author = text(43);
		tpoin = w16(0x6b);
		seqptr = w16(0x6d);
		instptr = w16(0x6f);
		infoptr = w16(0x71);
		extraPtr = w16(0x73);
	} else {
		version = d[0];
		speedHz = d[1];
		subsongs = d[2];
		tpoin = w16(3);
		seqptr = w16(5);
		instptr = w16(7);
		infoptr = w16(9);
		extraPtr = w16(11);
	}
	if (version > 4 || !subsongs) throw new Error('unsupported D00 version');
	if (version === 0) speedHz = 70;
	const spfx = version === 4 ? extraPtr : -1;
	const levpuls = version === 1 || version === 2 ? extraPtr : -1;
	void infoptr;

	// accessors on the packed tables; `ok` mirrors the bounds checks of the reference replayer
	const instOk = (i: number): boolean => instptr + (i + 1) * 16 <= size;
	const instB = (i: number, k: number): number => d[instptr + i * 16 + k];
	const spfxOk = (i: number): boolean => spfx >= 0 && spfx + (i + 1) * 8 <= size;
	const spfxInstnr = (i: number): number => w16(spfx + i * 8);
	const spfxHalfnote = (i: number): number => (d[spfx + i * 8 + 2] << 24) >> 24;
	const spfxModlev = (i: number): number => d[spfx + i * 8 + 3];
	const spfxModlevadd = (i: number): number => (d[spfx + i * 8 + 4] << 24) >> 24;
	const spfxDuration = (i: number): number => d[spfx + i * 8 + 5];
	const spfxPtr = (i: number): number => w16(spfx + i * 8 + 6);
	const lpOk = (i: number): boolean => levpuls >= 0 && levpuls + (i + 1) * 4 <= size;
	const lpLevel = (i: number): number => d[levpuls + i * 4];
	const lpVoladd = (i: number): number => (d[levpuls + i * 4 + 1] << 24) >> 24;
	const lpDuration = (i: number): number => d[levpuls + i * 4 + 2];
	const lpPtr = (i: number): number => d[levpuls + i * 4 + 3];

	const log = new EventLog();
	const wr = (reg: number, v: number): void => log.push(0, reg, v & 0xff);
	const channel = Array.from({ length: 9 }, newChan);
	let songend = false;

	const subsong = Math.min(options.subsong ?? 0, subsongs - 1);
	const dataofs = subsong * 32 + tpoin;
	for (let i = 0; i < 9; i++) {
		const c = channel[i];
		const ptr = dataofs + 32 <= size ? w16(dataofs + i * 2) : 0;
		if (ptr && ptr + 4 <= size) {
			c.speed = w16(ptr);
			c.order = ptr + 2;
		} else {
			c.speed = 0;
			c.order = -1;
		}
		c.ispfx = 0xffff;
		c.spfx = 0xffff;
		c.ilevpuls = 0xff;
		c.levpuls = 0xff;
		c.cvol = (dataofs + 32 <= size ? d[dataofs + 18 + i] : 0) & 0x7f;
		c.vol = c.cvol;
	}
	wr(1, 32);

	const setvolume = (chan: number): void => {
		const op = OP_TABLE[chan];
		const insnr = channel[chan].inst;
		if (!instOk(insnr)) return;
		const c = channel[chan];
		wr(0x43 + op, Math.trunc(63 - ((63 - (instB(insnr, 2) & 63)) / 63) * (63 - c.vol)) + (instB(insnr, 2) & 192));
		if (instB(insnr, 10) & 1)
			wr(0x40 + op, Math.trunc(63 - ((63 - c.modvol) / 63) * (63 - c.vol)) + (instB(insnr, 7) & 192));
		else wr(0x40 + op, c.modvol + (instB(insnr, 7) & 192));
	};
	const setfreq = (chan: number): void => {
		const c = channel[chan];
		let freq = c.freq;
		if (version === 4 && instOk(c.inst)) freq += instB(c.inst, 11);
		freq = u16(freq + c.slideval);
		wr(0xa0 + chan, freq & 255);
		wr(0xb0 + chan, c.key ? ((freq >> 8) & 31) | 32 : (freq >> 8) & 31);
	};
	const setinst = (chan: number): void => {
		const op = OP_TABLE[chan];
		const insnr = channel[chan].inst;
		if (!instOk(insnr)) return;
		wr(0x63 + op, instB(insnr, 0));
		wr(0x83 + op, instB(insnr, 1));
		wr(0x23 + op, instB(insnr, 3));
		wr(0xe3 + op, instB(insnr, 4));
		wr(0x60 + op, instB(insnr, 5));
		wr(0x80 + op, instB(insnr, 6));
		wr(0x20 + op, instB(insnr, 8));
		wr(0xe0 + op, instB(insnr, 9));
		if (version) wr(0xc0 + chan, instB(insnr, 10));
		else wr(0xc0 + chan, (instB(insnr, 10) << 1) + (instB(insnr, 11) & 1));
	};
	const playnote = (chan: number): void => {
		wr(0xb0 + chan, 0);
		setinst(chan);
		channel[chan].key = 1;
		setfreq(chan);
		setvolume(chan);
	};
	const vibrato = (chan: number): void => {
		const c = channel[chan];
		if (!c.vibdepth) return;
		if (c.trigger) c.trigger--;
		else {
			c.trigger = c.vibdepth;
			c.vibspeed = s16(-c.vibspeed);
		}
		c.freq = u16(c.freq + c.vibspeed);
		setfreq(chan);
	};
	const noteFreq = (noteIn: number): number => {
		const note = noteIn & 255;
		return u16(NOTE_TABLE[note % 12] + (Math.floor(note / 12) << 10));
	};
	const update = (): boolean => {
		for (let c = 0; c < 9; c++) {
			const ch = channel[c];
			ch.slideval = s16(ch.slideval + ch.slide);
			setfreq(c);
			vibrato(c);
			if (ch.spfx !== 0xffff) {
				if (ch.fxdel) ch.fxdel--;
				else {
					ch.spfx = spfxPtr(ch.spfx);
					if (ch.spfx === 0xffff || !spfxOk(ch.spfx)) ch.spfx = 0xffff;
					else {
						ch.fxdel = spfxDuration(ch.spfx);
						ch.inst = spfxInstnr(ch.spfx) & 0xfff;
						if (spfxModlev(ch.spfx) !== 0xff) ch.modvol = spfxModlev(ch.spfx);
						setinst(c);
						const note =
							spfxInstnr(ch.spfx) & 0x8000 ? spfxHalfnote(ch.spfx) : spfxHalfnote(ch.spfx) + ch.note;
						ch.freq = noteFreq(note);
						setfreq(c);
					}
				}
				if (ch.spfx !== 0xffff) {
					ch.modvol = (ch.modvol + spfxModlevadd(ch.spfx)) & 63;
					setvolume(c);
				}
			}
			if (ch.levpuls !== 0xff) {
				if (ch.frameskip) ch.frameskip--;
				else if (instOk(ch.inst)) {
					ch.frameskip = instB(ch.inst, 12);
					if (ch.fxdel) ch.fxdel--;
					else if (lpOk(ch.levpuls)) {
						ch.levpuls = u8(lpPtr(ch.levpuls) - 1);
						ch.fxdel = lpDuration(ch.levpuls);
						if (lpLevel(ch.levpuls) !== 0xff) ch.modvol = lpLevel(ch.levpuls);
					}
					if (lpOk(ch.levpuls)) {
						ch.modvol = (ch.modvol + lpVoladd(ch.levpuls)) & 63;
						setvolume(c);
					}
				}
			}
		}

		for (let c = 0; c < 9; c++) {
			const ch = channel[c];
			let patt = -1;
			const active = version < 3 ? ch.del !== 0 : ch.del <= 0x7f;
			if (active) {
				if (version === 4 && ch.del === instB(ch.inst, 12) && ch.nextnote)
					wr(0x83 + OP_TABLE[c], instB(ch.inst, 13));
				if (version < 3) ch.del = u16(ch.del - 1);
				else if (ch.speed) ch.del = u16(ch.del + ch.speed);
				else {
					ch.seqend = 1;
					continue;
				}
				continue;
			}
			if (ch.speed) {
				if (version < 3) ch.del = ch.speed;
				else {
					ch.del &= 0x7f;
					ch.del = u16(ch.del + ch.speed);
				}
			} else {
				ch.seqend = 1;
				continue;
			}
			if (ch.rhcnt) {
				ch.rhcnt--;
				continue;
			}
			// arrangement
			let guard = 0;
			let needOrder = true;
			let stop = false;
			while (needOrder && guard++ < 10000) {
				needOrder = false;
				if (ch.order < 0 || ch.order + (ch.ordpos + 1) * 2 > size) {
					ch.seqend = 1;
					stop = true;
					break;
				}
				let ord = w16(ch.order + ch.ordpos * 2);
				if (ord === 0xfffe) {
					ch.seqend = 1;
					stop = true;
					break;
				}
				if (ord === 0xffff) {
					ch.seqend = 1;
					if (ch.order + (ch.ordpos + 2) * 2 > size) {
						stop = true;
						break;
					}
					ch.ordpos = w16(ch.order + (ch.ordpos + 1) * 2);
					needOrder = true;
					continue;
				}
				if (ord >= 0x9000) {
					ch.speed = ord & 0xff;
					ord = ch.ordpos > 0 ? w16(ch.order + (ch.ordpos - 1) * 2) : 0;
					ch.ordpos++;
				} else if (ord >= 0x8000) {
					ch.transpose = ord & 0xff;
					if (ord & 0x100) ch.transpose = -ch.transpose;
					if (ch.order + (ch.ordpos + 2) * 2 > size) {
						ch.seqend = 1;
						stop = true;
						break;
					}
					ord = w16(ch.order + ++ch.ordpos * 2);
				}
				if (seqptr + (ord + 1) * 2 > size || w16(seqptr + ord * 2) + 2 > size) {
					ch.seqend = 1;
					stop = true;
					break;
				}
				patt = w16(seqptr + ord * 2);
				ch.fxflag = 0;
				// sequence
				let readseq = true;
				let seqGuard = 0;
				while (readseq && seqGuard++ < 10000) {
					readseq = false;
					if (!version) ch.rhcnt = ch.irhcnt;
					const pOk = (idx: number): boolean => patt + (idx + 1) * 2 <= size;
					let pattpos = pOk(ch.pattpos) ? w16(patt + ch.pattpos * 2) : 0xffff;
					if (pattpos === 0xffff) {
						ch.pattpos = 0;
						ch.ordpos++;
						needOrder = true;
						break;
					}
					let cnt = pattpos >> 8;
					let note = pattpos & 0xff;
					const fx = pattpos >> 12;
					const fxop = pattpos & 0x0fff;
					ch.pattpos++;
					pattpos = pOk(ch.pattpos) ? w16(patt + ch.pattpos * 2) : 0;
					ch.nextnote = pattpos & 0xff & 0x7f;
					if (version ? cnt < 0x40 : !fx) {
						if (note === 0 || note === 0x80 || note === 0x7e) {
							if (note === 0 || (note === 0x80 && version)) {
								ch.key = 0;
								setfreq(c);
							}
							if (version) ch.rhcnt = cnt;
							ch.nextnote = 0;
						} else {
							if (!(ch.fxflag & 1)) ch.vibdepth = 0;
							if (!(ch.fxflag & 2)) ch.slideval = ch.slide = 0;
							if (version) {
								if (note > 0x80) note -= 0x80;
								else note = u8(note + ch.transpose);
								ch.note = note;
								if (ch.ispfx !== 0xffff && cnt < 0x20 && spfxOk(ch.ispfx)) {
									ch.spfx = ch.ispfx;
									if (spfxInstnr(ch.spfx) & 0x8000) note = spfxHalfnote(ch.spfx);
									else note = u8(note + spfxHalfnote(ch.spfx));
									ch.inst = spfxInstnr(ch.spfx) & 0xfff;
									ch.fxdel = spfxDuration(ch.spfx);
									ch.modvol =
										spfxModlev(ch.spfx) !== 0xff ? spfxModlev(ch.spfx) : instB(ch.inst, 7) & 63;
								}
								if (ch.ilevpuls !== 0xff && cnt < 0x20 && lpOk(ch.ilevpuls) && instOk(ch.inst)) {
									ch.levpuls = ch.ilevpuls;
									ch.fxdel = lpDuration(ch.levpuls);
									ch.frameskip = instB(ch.inst, 12);
									ch.modvol =
										lpLevel(ch.levpuls) !== 0xff ? lpLevel(ch.levpuls) : instB(ch.inst, 7) & 63;
								}
								ch.freq = noteFreq(note);
								if (cnt < 0x20) playnote(c);
								else {
									setfreq(c);
									cnt -= 0x20;
								}
								ch.rhcnt = cnt;
							} else {
								if (cnt < 2) note = u8(note + ch.transpose);
								ch.note = note;
								ch.freq = noteFreq(note);
								if (cnt === 1) setfreq(c);
								else playnote(c);
							}
						}
						break;
					}
					// effect event
					let followed = true;
					switch (fx) {
						case 6: {
							const buf = ch.inst;
							ch.inst = 0;
							playnote(c);
							ch.inst = buf;
							ch.rhcnt = fxop;
							followed = false;
							break;
						}
						case 7:
							ch.vibspeed = fxop & 0xff;
							ch.vibdepth = fxop >> 8;
							ch.trigger = fxop >> 9;
							ch.fxflag |= 1;
							break;
						case 8:
							if (!version) ch.irhcnt = fxop;
							break;
						case 9:
							ch.vol = fxop & 63;
							if (ch.vol + ch.cvol < 63) ch.vol += ch.cvol;
							else ch.vol = 63;
							setvolume(c);
							break;
						case 0xb:
							if (version === 4) ch.ispfx = fxop;
							break;
						case 0xc:
							ch.ispfx = 0xffff;
							ch.spfx = 0xffff;
							ch.inst = fxop;
							if (!instOk(fxop)) {
								ch.modvol = 0;
								ch.levpuls = ch.ilevpuls = 0xff;
								break;
							}
							ch.modvol = instB(fxop, 7) & 63;
							if (version < 3 && version && instB(fxop, 11)) ch.ilevpuls = instB(fxop, 11) - 1;
							else {
								ch.ilevpuls = 0xff;
								ch.levpuls = 0xff;
							}
							break;
						case 0xd:
							ch.slide = fxop;
							ch.fxflag |= 2;
							break;
						case 0xe:
							ch.slide = -fxop;
							ch.fxflag |= 2;
							break;
					}
					if (followed) readseq = true;
					else break;
				}
				if (needOrder) continue;
			}
			if (stop) continue;
		}
		let end = 0;
		for (const ch of channel) if (ch.seqend) end++;
		if (end === 9) songend = true;
		return !songend;
	};

	const maxTicks = Math.ceil((options.maxSeconds ?? 900) * speedHz);
	let ticks = 0;
	while (ticks < maxTicks) {
		log.time = (ticks / speedHz) * TIMEBASE;
		ticks++;
		if (!update()) break;
	}
	log.time = (ticks / speedHz) * TIMEBASE + 0.5 * TIMEBASE;
	const data = log.build([{ id: 'opl2', clock: OPL_CLOCK }], speedHz, 'EdLib D00');
	data.title = title;
	data.author = author;
	return data;
}

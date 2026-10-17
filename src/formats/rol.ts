import type { MwaData } from './mwa.ts';
import { EventLog } from './opl-logs.ts';

/**
 * AdLib Visual Composer (`.rol` songs with `.bnk` instrument banks). A song is a list of voices (9 melodic, or 6
 * melodic + 5 percussion) each with note, instrument, volume and pitch-bend events on a tick grid; instruments are
 * looked up by name in a bank. The song is played tick by tick the way the Visual Composer driver did, and the OPL2
 * register writes are recorded as timed events (`MwaData`).
 *
 * The playing logic and the OPL programming follow the behaviour of the Visual Composer / AdLib Music SDK driver as
 * implemented by the free AdPlug replayer (LGPL-2.1-or-later): this file is therefore distributed under the same
 * licence, see the header below. A `.bnk` bank must be supplied (a song refers to its instruments by name).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

const MAX_VOICES = 11;
const NUM_MELODIC = MAX_VOICES - 2;
const NUM_PERCUSSIVE = MAX_VOICES;
const BASS_DRUM = 6;
const SNARE_DRUM = 7;
const TOM_TOM = 8;
const TOM_TOM_NOTE = 24;
const TOM_TOM_TO_SNARE = 7;
const SNARE_NOTE = TOM_TOM_NOTE + TOM_TOM_TO_SNARE;
const SILENCE_NOTE = -12;
const MID_PITCH = 0x2000;
const MAX_VOLUME = 0x7f;
const NR_STEP_PITCH = 25;
const MAX_NOTES = 96;
const CARRIER_OP_OFFSET = 3;
const OP_TABLE = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];
const DRUM_OP_TABLE = [0x14, 0x12, 0x15, 0x11];
const TIMEBASE = 44100;
const OPL_CLOCK = 3_579_545;

const F_NUM_NOTES: number[][] = [
	[343, 364, 385, 408, 433, 459, 486, 515, 546, 579, 614, 650],
	[344, 365, 387, 410, 434, 460, 488, 517, 548, 581, 615, 652],
	[345, 365, 387, 410, 435, 461, 489, 518, 549, 582, 617, 653],
	[346, 366, 388, 411, 436, 462, 490, 519, 550, 583, 618, 655],
	[346, 367, 389, 412, 437, 463, 491, 520, 551, 584, 619, 657],
	[347, 368, 390, 413, 438, 464, 492, 522, 553, 586, 621, 658],
	[348, 369, 391, 415, 439, 466, 493, 523, 554, 587, 622, 660],
	[349, 370, 392, 415, 440, 467, 495, 524, 556, 589, 624, 661],
	[350, 371, 393, 416, 441, 468, 496, 525, 557, 590, 625, 663],
	[351, 372, 394, 417, 442, 469, 497, 527, 558, 592, 627, 665],
	[351, 372, 395, 418, 443, 470, 498, 528, 559, 593, 628, 666],
	[352, 373, 396, 419, 444, 471, 499, 529, 561, 594, 630, 668],
	[353, 374, 397, 420, 445, 472, 500, 530, 562, 596, 631, 669],
	[354, 375, 398, 421, 447, 473, 502, 532, 564, 597, 633, 671],
	[355, 376, 398, 422, 448, 474, 503, 533, 565, 599, 634, 672],
	[356, 377, 399, 423, 449, 475, 504, 534, 566, 600, 636, 674],
	[356, 378, 400, 424, 450, 477, 505, 535, 567, 601, 637, 675],
	[357, 379, 401, 425, 451, 478, 506, 537, 569, 603, 639, 677],
	[358, 379, 402, 426, 452, 479, 507, 538, 570, 604, 640, 679],
	[359, 380, 403, 427, 453, 480, 509, 539, 571, 606, 642, 680],
	[360, 381, 404, 428, 454, 481, 510, 540, 572, 607, 643, 682],
	[360, 382, 405, 429, 455, 482, 511, 541, 574, 608, 645, 683],
	[361, 383, 406, 430, 456, 483, 512, 543, 575, 610, 646, 685],
	[362, 384, 407, 431, 457, 484, 513, 544, 577, 611, 648, 687],
	[363, 385, 408, 432, 458, 485, 514, 545, 578, 612, 649, 688],
];

interface Op {
	ammulti: number;
	ksltl: number;
	ardr: number;
	slrr: number;
	fbc: number;
	waveform: number;
}
interface Instrument {
	name: string;
	modulator: Op;
	carrier: Op;
}

export function isRol(b: Uint8Array, name = ''): boolean {
	return (
		name.toLowerCase().endsWith('.rol') && b.length > 0x100 && b[0] === 0 && b[1] === 0 && b[2] === 4 && b[3] === 0
	);
}

/** Parse the 30 byte instrument record of a bank */
function readOperator(b: Uint8Array, o: number): Op {
	const [ksl, mult, fb, ar, sl, sus, dr, rr, out, am, vib, eg, fmType] = Array.from(b.subarray(o, o + 13));
	return {
		ammulti: (am << 7) | (vib << 6) | (sus << 5) | (eg << 4) | mult,
		ksltl: (ksl << 6) | out,
		ardr: (ar << 4) | dr,
		slrr: (sl << 4) | rr,
		fbc: (fb << 1) | (fmType ^ 1),
		waveform: 0,
	};
}

/** Look an instrument up by name in a `.bnk` bank (case-insensitive), or return an empty instrument */
function bankInstrument(bnk: Uint8Array, wanted: string): Instrument {
	const v = new DataView(bnk.buffer, bnk.byteOffset, bnk.byteLength);
	const total = v.getUint16(10, true);
	const nameOffset = v.getInt32(12, true);
	const dataOffset = v.getInt32(16, true);
	const up = wanted.toUpperCase();
	for (let i = 0; i < total; i++) {
		const o = nameOffset + i * 12;
		if (o + 12 > bnk.length) break;
		const used = bnk[o + 2];
		const name = String.fromCharCode(...bnk.subarray(o + 3, o + 12)).replace(/\0.*$/, '');
		if (!used || name.toUpperCase() !== up) continue;
		const index = v.getUint16(o, true);
		const rec = dataOffset + index * 30;
		if (rec + 30 > bnk.length) break;
		const modulator = readOperator(bnk, rec + 2);
		const carrier = readOperator(bnk, rec + 15);
		modulator.waveform = bnk[rec + 28];
		carrier.waveform = bnk[rec + 29];
		return { name: wanted, modulator, carrier };
	}
	const blank: Op = { ammulti: 0, ksltl: 0, ardr: 0, slrr: 0, fbc: 0, waveform: 0 };
	return { name: wanted, modulator: { ...blank }, carrier: { ...blank } };
}

interface VoiceData {
	notes: { number: number; duration: number }[];
	instruments: { time: number; index: number }[];
	volumes: { time: number; multiplier: number }[];
	pitches: { time: number; variation: number }[];
	nextInstrument: number;
	nextVolume: number;
	nextPitch: number;
	currentNote: number;
	currentNoteDuration: number;
	noteDuration: number;
	forceNote: boolean;
	status: number;
}

const ES_NOTE_END = 1;
const ES_PITCH_END = 2;
const ES_INSTR_END = 4;
const ES_VOLUME_END = 8;

/** Compile a Visual Composer song and its instrument bank to OPL2 register writes */
export function parseRol(rol: Uint8Array, bnk: Uint8Array, options: { maxSeconds?: number } = {}): MwaData {
	const v = new DataView(rol.buffer, rol.byteOffset, rol.byteLength);
	if (v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 4)
		throw new Error('not a ROL file (version 0.4 expected)');
	let p = 4;
	const comment = String.fromCharCode(...rol.subarray(p, p + 40)).replace(/\0.*$/, '');
	p += 40;
	const ticksPerBeat = v.getUint16(p, true);
	p += 8; // ticks per beat, beats per measure, edit scales
	p += 1; // unused
	const mode = rol[p++];
	p += 90 + 38 + 15;
	const basicTempo = v.getFloat32(p, true);
	p += 4;
	const nTempo = v.getUint16(p, true);
	p += 2;
	const tempoEvents: { time: number; multiplier: number }[] = [];
	for (let i = 0; i < nTempo; i++) {
		tempoEvents.push({ time: v.getInt16(p, true), multiplier: v.getFloat32(p + 2, true) });
		p += 6;
	}

	const instruments: Instrument[] = [];
	const insIndex = (name: string): number => {
		const i = instruments.findIndex((x) => x.name.toUpperCase() === name.toUpperCase());
		if (i >= 0) return i;
		instruments.push(bankInstrument(bnk, name));
		return instruments.length - 1;
	};

	let timeOfLastNote = 0;
	const voices: VoiceData[] = [];
	const nVoices = mode ? NUM_MELODIC : NUM_PERCUSSIVE;
	for (let vi = 0; vi < nVoices; vi++) {
		const voice: VoiceData = {
			notes: [],
			instruments: [],
			volumes: [],
			pitches: [],
			nextInstrument: 0,
			nextVolume: 0,
			nextPitch: 0,
			currentNote: 0,
			currentNoteDuration: 0,
			noteDuration: 0,
			forceNote: true,
			status: 0,
		};
		p += 15;
		const last = v.getInt16(p, true);
		p += 2;
		if (last !== 0) {
			let total = 0;
			do {
				const number = v.getInt16(p, true);
				const duration = v.getInt16(p + 2, true);
				p += 4;
				voice.notes.push({ number, duration });
				total += duration;
			} while (total < last && p + 4 <= rol.length);
			timeOfLastNote = Math.max(timeOfLastNote, last);
		}
		p += 15;
		const nIns = v.getUint16(p, true);
		p += 2;
		for (let i = 0; i < nIns; i++) {
			const time = v.getInt16(p, true);
			const name = String.fromCharCode(...rol.subarray(p + 2, p + 11)).replace(/\0.*$/, '');
			p += 11 + 3;
			voice.instruments.push({ time, index: insIndex(name) });
		}
		p += 15;
		const nVol = v.getUint16(p, true);
		p += 2;
		for (let i = 0; i < nVol; i++) {
			voice.volumes.push({ time: v.getInt16(p, true), multiplier: v.getFloat32(p + 2, true) });
			p += 6;
		}
		p += 15;
		const nPitch = v.getUint16(p, true);
		p += 2;
		for (let i = 0; i < nPitch; i++) {
			voice.pitches.push({ time: v.getInt16(p, true), variation: v.getFloat32(p + 2, true) });
			p += 6;
		}
		voices.push(voice);
	}

	// ---- the Composer driver
	const log = new EventLog();
	const wr = (reg: number, val: number): void => log.push(0, reg, val & 0xff);
	const fnumPtr: number[][] = Array.from({ length: NUM_PERCUSSIVE }, () => F_NUM_NOTES[0]);
	const halfToneOffset = new Array<number>(NUM_PERCUSSIVE).fill(0);
	const volumeCache = new Array<number>(NUM_PERCUSSIVE).fill(MAX_VOLUME);
	const ksltlCache = new Array<number>(NUM_PERCUSSIVE).fill(0);
	const noteCache = new Array<number>(NUM_PERCUSSIVE).fill(0);
	const kOnOctFNum = new Array<number>(NUM_MELODIC).fill(0);
	const keyOn = new Array<boolean>(NUM_PERCUSSIVE).fill(false);
	let rhythmMode = 0;
	let oldPitchBendLength = ~0;
	let pitchRangeStep = NR_STEP_PITCH;
	let oldHalfToneOffset = 0;
	let oldFnum: number[] = F_NUM_NOTES[0];
	let amVibRhythm = 0;

	const getKsltl = (voice: number): number => {
		let kslTL = 0x3f - (ksltlCache[voice] & 0x3f);
		kslTL = volumeCache[voice] * kslTL;
		kslTL += kslTL + MAX_VOLUME;
		kslTL = 0x3f - Math.floor(kslTL / (2 * MAX_VOLUME));
		kslTL |= ksltlCache[voice] & 0xc0;
		return kslTL & 0xff;
	};
	const setFreq = (voice: number, note: number, on = false): void => {
		const biased = Math.max(0, Math.min(MAX_NOTES - 1, note + halfToneOffset[voice]));
		const frequency = fnumPtr[voice][biased % 12];
		noteCache[voice] = note;
		keyOn[voice] = on;
		kOnOctFNum[voice] = (Math.floor(biased / 12) << 2) | ((frequency >> 8) & 3);
		wr(0xa0 + voice, frequency & 0xff);
		wr(0xb0 + voice, kOnOctFNum[voice] | (on ? 0x20 : 0));
	};
	const setRhythmMode = (m: number): void => {
		if (m) {
			amVibRhythm |= 0x20;
			wr(0xbd, amVibRhythm);
			setFreq(TOM_TOM, TOM_TOM_NOTE);
			setFreq(SNARE_DRUM, SNARE_NOTE);
		} else {
			amVibRhythm &= ~0x20;
			wr(0xbd, amVibRhythm);
		}
		rhythmMode = m;
	};
	const setNotePercussive = (voice: number, note: number): void => {
		const mask = 1 << (4 - voice + BASS_DRUM);
		amVibRhythm &= ~mask;
		wr(0xbd, amVibRhythm);
		keyOn[voice] = false;
		if (note !== SILENCE_NOTE) {
			if (voice === TOM_TOM) {
				setFreq(TOM_TOM, note);
				setFreq(SNARE_DRUM, note + TOM_TOM_TO_SNARE);
			} else if (voice === BASS_DRUM) setFreq(voice, note);
			keyOn[voice] = true;
			amVibRhythm |= mask;
			wr(0xbd, amVibRhythm);
		}
	};
	const setNoteMelodic = (voice: number, note: number): void => {
		if (voice >= NUM_MELODIC) return;
		wr(0xb0 + voice, kOnOctFNum[voice] & ~0x20);
		keyOn[voice] = false;
		if (note !== SILENCE_NOTE) setFreq(voice, note, true);
	};
	const setNote = (voice: number, note: number): void => {
		if (voice < BASS_DRUM || !rhythmMode) setNoteMelodic(voice, note);
		else setNotePercussive(voice, note);
	};
	const noteOn = (voice: number, note: number): void => setNote(voice, note + SILENCE_NOTE);
	const noteOff = (voice: number): void => setNote(voice, SILENCE_NOTE);
	const changePitch = (voice: number, pitchBend: number): void => {
		const length = (pitchBend - MID_PITCH) * pitchRangeStep;
		if (voice >= BASS_DRUM && rhythmMode) return;
		if (oldPitchBendLength === length) {
			fnumPtr[voice] = oldFnum;
			halfToneOffset[voice] = oldHalfToneOffset;
		} else {
			const stepDir = Math.trunc(length / MID_PITCH);
			let delta: number;
			if (stepDir < 0) {
				const stepDown = NR_STEP_PITCH - 1 - stepDir;
				oldHalfToneOffset = halfToneOffset[voice] = -Math.trunc(stepDown / NR_STEP_PITCH);
				delta = (stepDown - NR_STEP_PITCH + 1) % NR_STEP_PITCH;
				if (delta) delta = NR_STEP_PITCH - delta;
			} else {
				oldHalfToneOffset = halfToneOffset[voice] = Math.trunc(stepDir / NR_STEP_PITCH);
				delta = stepDir % NR_STEP_PITCH;
			}
			oldFnum = fnumPtr[voice] = F_NUM_NOTES[delta];
			oldPitchBendLength = length;
		}
		setFreq(voice, noteCache[voice], keyOn[voice]);
	};
	const setVolume = (voice: number, volume: number): void => {
		if (voice >= NUM_MELODIC && !rhythmMode) return;
		const opOffset =
			voice < SNARE_DRUM || !rhythmMode ? OP_TABLE[voice] + CARRIER_OP_OFFSET : DRUM_OP_TABLE[voice - SNARE_DRUM];
		volumeCache[voice] = volume;
		wr(0x40 + opOffset, getKsltl(voice));
	};
	const setInstrument = (voice: number, index: number): void => {
		if (voice >= NUM_MELODIC && !rhythmMode) return;
		const { modulator, carrier } = instruments[index];
		if (voice < SNARE_DRUM || !rhythmMode) {
			if (voice >= NUM_MELODIC) return;
			const op = OP_TABLE[voice];
			wr(0x20 + op, modulator.ammulti);
			wr(0x40 + op, modulator.ksltl);
			wr(0x60 + op, modulator.ardr);
			wr(0x80 + op, modulator.slrr);
			wr(0xc0 + voice, modulator.fbc);
			wr(0xe0 + op, modulator.waveform);
			ksltlCache[voice] = carrier.ksltl;
			wr(0x20 + op + CARRIER_OP_OFFSET, carrier.ammulti);
			wr(0x40 + op + CARRIER_OP_OFFSET, getKsltl(voice));
			wr(0x60 + op + CARRIER_OP_OFFSET, carrier.ardr);
			wr(0x80 + op + CARRIER_OP_OFFSET, carrier.slrr);
			wr(0xe0 + op + CARRIER_OP_OFFSET, carrier.waveform);
		} else {
			const op = DRUM_OP_TABLE[voice - SNARE_DRUM];
			ksltlCache[voice] = modulator.ksltl;
			wr(0x20 + op, modulator.ammulti);
			wr(0x40 + op, getKsltl(voice));
			wr(0x60 + op, modulator.ardr);
			wr(0x80 + op, modulator.slrr);
			wr(0xe0 + op, modulator.waveform);
		}
	};

	// rewind: OPL init, waveform select, rhythm mode from the song mode
	wr(1, 0x20);
	setRhythmMode(mode ^ 1);
	let refresh = 0;
	const setRefresh = (multiplier: number): void => {
		const tickBeat = Math.min(60, ticksPerBeat);
		refresh = (tickBeat * basicTempo * multiplier) / 60;
	};
	setRefresh(1);

	let nextTempo = 0;
	let currTick = 0;
	let seconds = 0;
	const maxSeconds = options.maxSeconds ?? 900;
	const updateVoice = (voice: number, vd: VoiceData): void => {
		if (!vd.notes.length || vd.status & ES_NOTE_END) return;
		if (!(vd.status & ES_INSTR_END)) {
			if (vd.nextInstrument < vd.instruments.length) {
				if (vd.instruments[vd.nextInstrument].time === currTick) {
					setInstrument(voice, vd.instruments[vd.nextInstrument].index);
					vd.nextInstrument++;
				}
			} else vd.status |= ES_INSTR_END;
		}
		if (!(vd.status & ES_VOLUME_END)) {
			if (vd.nextVolume < vd.volumes.length) {
				if (vd.volumes[vd.nextVolume].time === currTick) {
					setVolume(voice, Math.trunc(MAX_VOLUME * vd.volumes[vd.nextVolume].multiplier) & 0xff);
					vd.nextVolume++;
				}
			} else vd.status |= ES_VOLUME_END;
		}
		if (vd.forceNote || vd.currentNoteDuration > vd.noteDuration - 1) {
			if (currTick !== 0) vd.currentNote++;
			if (vd.currentNote < vd.notes.length) {
				const ev = vd.notes[vd.currentNote];
				noteOn(voice, ev.number);
				vd.currentNoteDuration = 0;
				vd.noteDuration = ev.duration;
				vd.forceNote = false;
			} else {
				noteOff(voice);
				vd.status |= ES_NOTE_END;
				return;
			}
		}
		if (!(vd.status & ES_PITCH_END)) {
			if (vd.nextPitch < vd.pitches.length) {
				if (vd.pitches[vd.nextPitch].time === currTick) {
					const variation = vd.pitches[vd.nextPitch].variation;
					changePitch(voice, variation === 1 ? MID_PITCH : Math.trunc((0x3fff >> 1) * variation));
					vd.nextPitch++;
				}
			} else vd.status |= ES_PITCH_END;
		}
		vd.currentNoteDuration++;
	};

	for (;;) {
		log.time = seconds * TIMEBASE;
		if (nextTempo < tempoEvents.length && tempoEvents[nextTempo].time === currTick) {
			setRefresh(tempoEvents[nextTempo].multiplier);
			nextTempo++;
		}
		voices.forEach((vd, i) => updateVoice(i, vd));
		currTick++;
		seconds += 1 / Math.max(1, refresh);
		if (currTick > timeOfLastNote || seconds > maxSeconds) break;
	}
	log.time = seconds * TIMEBASE + 0.5 * TIMEBASE;
	const data = log.build([{ id: 'opl2', clock: OPL_CLOCK }], refresh || 18.2, comment);
	data.title = comment;
	return data;
}

import type { MwaData } from './mwa.ts';
import { EventLog } from './opl-logs.ts';

/**
 * Sierra SCI0 sound resources (King's Quest IV, Space Quest III, Leisure Suit Larry 2, Police Quest 1 / 2 ...) on the
 * AdLib: one MIDI-like event stream after a header (0x21 bytes in the late SCI0 games, 0x11 in the earliest), played
 * by the Sierra AdLib driver with the instruments of `patch.003` (48 or 96 FM voices of 28 bytes). The driver is
 * reproduced and its OPL2 register writes are recorded as timed events (`MwaData`): the per-channel voice allocation
 * of the header and of controller 0x4B, voice stealing, note velocity, hold pedal, pitch wheel and the driver's own
 * note frequency table.
 *
 * Written after the documented behaviour of the SCI AdLib driver (ScummVM, GPL-2.0-or-later:
 * `engines/sci/sound/drivers/adlib.cpp` and `midiparser_sci.cpp`) and the patch format notes of Ravi I. (2002); no code
 * was copied, the tables are data of the original Sierra driver. Resources may carry the 2 byte resource header the
 * extraction tools add (`84 00` for sounds, `89 00` for patches): it is skipped when present. SCI1 and later sounds
 * (track directory, other drivers) are not read. Mono (the dual OPL2 stereo panning of the driver is not rendered).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

const TIMEBASE = 44100;
const OPL_CLOCK = 3_579_545;
const TICK_HZ = 60;
const VOICES = 9;
const REGISTER_OFFSET = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];
const ADLIB_FREQ = [
	0x157, 0x15c, 0x161, 0x166, 0x16b, 0x171, 0x176, 0x17b, 0x181, 0x186, 0x18c, 0x192, 0x198, 0x19e, 0x1a4, 0x1aa,
	0x1b0, 0x1b6, 0x1bd, 0x1c3, 0x1ca, 0x1d0, 0x1d7, 0x1de, 0x1e5, 0x1ec, 0x1f3, 0x1fa, 0x202, 0x209, 0x211, 0x218,
	0x220, 0x228, 0x230, 0x238, 0x241, 0x249, 0x252, 0x25a, 0x263, 0x26c, 0x275, 0x27e, 0x287, 0x290, 0x29a, 0x2a4,
];
/** data bytes following the status 0x80..0xE0 */
const N_PARAMS = [2, 2, 2, 2, 1, 1, 2];

export interface SciOperator {
	kbScaleLevel: number;
	frequencyMult: number;
	attackRate: number;
	sustainLevel: number;
	envelopeType: number;
	decayRate: number;
	releaseRate: number;
	totalLevel: number;
	amplitudeMod: number;
	vibrato: number;
	kbScaleRate: number;
	waveForm: number;
}
export interface SciPatch {
	op: [SciOperator, SciOperator];
	feedback: number;
	/** 1 = additive (both operators sound), 0 = operator 1 modulates operator 2 */
	algorithm: number;
}

const blankOp = (): SciOperator => ({
	kbScaleLevel: 0,
	frequencyMult: 0,
	attackRate: 0,
	sustainLevel: 0,
	envelopeType: 0,
	decayRate: 0,
	releaseRate: 0,
	totalLevel: 0,
	amplitudeMod: 0,
	vibrato: 0,
	kbScaleRate: 0,
	waveForm: 0,
});

/** drop the 2 byte resource header (`type | 0x80`, `0x00`) that extractors add in front of the data */
function stripResourceHeader(b: Uint8Array, types: number[]): Uint8Array {
	return b.length > 2 && b[1] === 0 && types.includes(b[0]) ? b.subarray(2) : b;
}

/** Read the instruments of a `patch.003` / `3.pat`: 1344 bytes (48), 2690 (96, with the `AB CD` marker) or 5382 */
export function parseSciPatch(file: Uint8Array): SciPatch[] {
	const data = stripResourceHeader(file, [0x89, 0x09]);
	if (![1344, 2690, 5382].includes(data.length)) throw new Error(`unsupported SCI patch.003 size ${data.length}`);
	const patches: SciPatch[] = [];
	const load = (o: number): void => {
		const ops = [0, 1].map((i) => {
			const p = o + i * 13;
			return {
				kbScaleLevel: data[p] & 3,
				frequencyMult: data[p + 1] & 15,
				attackRate: data[p + 3] & 15,
				sustainLevel: data[p + 4] & 15,
				envelopeType: data[p + 5] ? 1 : 0,
				decayRate: data[p + 6] & 15,
				releaseRate: data[p + 7] & 15,
				totalLevel: data[p + 8] & 63,
				amplitudeMod: data[p + 9] ? 1 : 0,
				vibrato: data[p + 10] ? 1 : 0,
				kbScaleRate: data[p + 11] ? 1 : 0,
				waveForm: 0,
			};
		}) as [SciOperator, SciOperator];
		ops[0].waveForm = data[o + 26] & 3;
		ops[1].waveForm = data[o + 27] & 3;
		patches.push({ op: ops, feedback: data[o + 2] & 7, algorithm: data[o + 12] ? 0 : 1 });
	};
	for (let i = 0; i < 48; i++) load(28 * i);
	if (data.length === 1344)
		for (let i = 0; i < 48; i++) patches.push({ op: [blankOp(), blankOp()], feedback: 0, algorithm: 1 });
	else if (data.length === 2690) for (let i = 48; i < 96; i++) load(2 + 28 * i);
	else for (let i = 48; i < 190; i++) load(28 * i);
	return patches;
}

export interface SciOptions {
	/** the instrument bank (`patch.003`); required */
	patch: Uint8Array;
	/** 'late' SCI0 (header of 0x21 bytes, default for King's Quest IV v1.006), 'early' (0x11 bytes, 8 voices) or 'auto' */
	version?: 'early' | 'late' | 'auto';
	/** longest playback in seconds (default 600) */
	maxSeconds?: number;
}

/** true for a sound resource that looks like SCI0 (header, then a delta + status event stream) */
export function isSci0Sound(file: Uint8Array, name = ''): boolean {
	const b = stripResourceHeader(file, [0x84, 0x04]);
	if (!/(\.sci|sound\.\d+)$/i.test(name) || b.length < 0x14) return false;
	return b[0] === 0 || b[0] === 2;
}

function pickVersion(b: Uint8Array, wanted: 'early' | 'late' | 'auto'): 'early' | 'late' {
	if (wanted !== 'auto') return wanted;
	// the stream starts with a delta, then a status byte (>= 0x80)
	const ok = (hdr: number): boolean => b.length > hdr + 2 && b[hdr + 1] >= 0x80 && b[hdr + 1] < 0xf0;
	if (ok(0x21)) return 'late';
	if (ok(0x11)) return 'early';
	return 'late';
}

/** Play a SCI0 sound resource through the AdLib driver and return the OPL2 register log */
export function parseSci0(file: Uint8Array, options: SciOptions): MwaData {
	const sound = stripResourceHeader(file, [0x84, 0x04]);
	const patches = parseSciPatch(options.patch);
	const version = pickVersion(sound, options.version ?? 'auto');
	const early = version === 'early';
	const headerSize = early ? 0x11 : 0x21;
	if (sound.length <= headerSize) throw new Error('SCI0 sound: truncated');
	const maxVoices = early ? 8 : VOICES;
	const stream = sound.subarray(headerSize);

	// ---- which MIDI channels the AdLib plays, and their voice counts
	const play: boolean[] = new Array(16).fill(false);
	const wantedVoices: number[] = new Array(16).fill(0);
	let hdr = 1;
	for (let ch = 0; ch < 16; ch++) {
		if (early) {
			const val = sound[hdr++];
			play[ch] = ch === 15 || (val & 1) !== 0;
			wantedVoices[ch] = val & 1 && !(val & 8) && val >> 4 !== 0x0f ? val >> 4 : 0;
		} else {
			const num = sound[hdr++] & 0x7f;
			const flags = sound[hdr++];
			play[ch] = ch === 15 || (flags & 0x04) !== 0;
			wantedVoices[ch] = flags & 0x04 ? num : 0;
		}
	}

	// ---- driver state
	const log = new EventLog();
	const wr = (reg: number, value: number): void => log.push(0, reg, value & 0xff);
	const channels = Array.from({ length: 16 }, () => ({
		patch: 13,
		pitchWheel: 8192,
		holdPedal: 0,
		lastVoice: 0,
		enableVelocity: false,
		voices: 0,
		mappedVoices: 0,
		pan: 64,
	}));
	const voices = Array.from({ length: VOICES }, () => ({
		channel: -1,
		mappedChannel: -1,
		note: -1,
		patch: 13,
		velocity: 0,
		isSustained: false,
		age: 0,
	}));
	const masterVolume = 15;

	const setOperator = (reg: number, op: SciOperator): void => {
		wr(0x40 + reg, (op.kbScaleLevel << 6) | op.totalLevel);
		wr(0x60 + reg, (op.attackRate << 4) | op.decayRate);
		wr(0x80 + reg, (op.sustainLevel << 4) | op.releaseRate);
		wr(
			0x20 + reg,
			(op.amplitudeMod << 7) |
				(op.vibrato << 6) |
				(op.envelopeType << 5) |
				(op.kbScaleRate << 4) |
				op.frequencyMult,
		);
		wr(0xe0 + reg, op.waveForm);
	};
	const setPatch = (voice: number, patchIndex: number): void => {
		const index = patchIndex >= 0 && patchIndex < patches.length ? patchIndex : 0;
		voices[voice].patch = index;
		const p = patches[index];
		setOperator(REGISTER_OFFSET[voice], p.op[0]);
		setOperator(REGISTER_OFFSET[voice] + 3, p.op[1]);
		wr(0xc0 + voice, (p.feedback << 1) | p.algorithm);
	};
	const calcVelocity = (voice: number, op: number): number => {
		let velocity = masterVolume;
		if (velocity > 0) velocity += 3;
		if (velocity > 15) velocity = 15;
		const insVelocity = channels[voices[voice].channel].enableVelocity
			? voices[voice].velocity
			: 63 - patches[voices[voice].patch].op[op].totalLevel;
		return Math.floor((velocity * insVelocity) / 15);
	};
	const setVelocity = (voice: number): void => {
		const p = patches[voices[voice].patch];
		wr(0x40 + REGISTER_OFFSET[voice] + 3, (p.op[1].kbScaleLevel << 6) | (63 - calcVelocity(voice, 1)));
		if (p.algorithm === 1)
			wr(0x40 + REGISTER_OFFSET[voice], (p.op[0].kbScaleLevel << 6) | (63 - calcVelocity(voice, 0)));
	};
	const setNote = (voice: number, note: number, key: boolean): void => {
		const channel = voices[voice].channel;
		voices[voice].note = note;
		let index = note << 2;
		let wheel = channels[channel].pitchWheel;
		let sign: number;
		if (wheel === 0x2000) {
			wheel = 0;
			sign = 0;
		} else if (wheel > 0x2000) {
			wheel -= 0x2000;
			sign = 1;
		} else {
			wheel = 0x2000 - wheel;
			sign = -1;
		}
		wheel = Math.floor(wheel / 171);
		index += sign === 1 ? wheel : -wheel;
		if (index > 0x1fc) index = 0x1fc;
		if (index < 0) index = 0;
		const freq = ADLIB_FREQ[index % 48];
		wr(0xa0 + voice, freq & 0xff);
		let oct = Math.floor(index / 48);
		if (oct > 0) oct--;
		if (oct > 7) oct = 7;
		wr(0xb0 + voice, ((key ? 1 : 0) << 5) | (oct << 2) | (freq >> 8));
		setVelocity(voice);
	};
	const voiceOff = (voice: number): void => {
		const channel = voices[voice].channel;
		voices[voice].isSustained = false;
		setNote(voice, voices[voice].note, false);
		voices[voice].note = -1;
		voices[voice].age = 0;
		if (channel >= 0) channels[channel].voices--;
	};
	const voiceOn = (voice: number, note: number, velocity: number): void => {
		const channel = voices[voice].channel;
		voices[voice].age = 0;
		channels[channel].voices++;
		if (channels[channel].patch !== voices[voice].patch) setPatch(voice, channels[channel].patch);
		voices[voice].velocity = velocity;
		setNote(voice, note, true);
	};
	const assignVoices = (channel: number, count: number): void => {
		for (let i = 0; i < maxVoices && count > 0; i++) {
			if (voices[i].mappedChannel === -1) {
				if (voices[i].note !== -1) voiceOff(i);
				voices[i].mappedChannel = channel;
				channels[channel].mappedVoices++;
				count--;
			}
		}
	};
	const releaseVoices = (channel: number, count: number): void => {
		for (let i = 0; i < maxVoices && count > 0; i++) {
			if (voices[i].mappedChannel === channel && voices[i].note === -1) {
				voices[i].mappedChannel = -1;
				channels[channel].mappedVoices--;
				count--;
			}
		}
		for (let i = 0; i < maxVoices && count > 0; i++) {
			if (voices[i].mappedChannel === channel) {
				voiceOff(i);
				voices[i].mappedChannel = -1;
				channels[channel].mappedVoices--;
				count--;
			}
		}
	};
	const voiceMapping = (channel: number, wanted: number): void => {
		let cur = 0;
		for (let i = 0; i < maxVoices; i++) if (voices[i].mappedChannel === channel) cur++;
		if (cur < wanted) assignVoices(channel, wanted - cur);
		else if (cur > wanted) releaseVoices(channel, cur - wanted);
	};
	const findVoice = (channel: number): number => {
		let voice = -1;
		let oldest = -1;
		let oldestAge = 0;
		for (let i = 0; i < VOICES; i++) {
			const v = (channels[channel].lastVoice + i + 1) % VOICES;
			if (voices[v].mappedChannel === channel) {
				if (voices[v].note === -1) {
					voice = v;
					voices[v].channel = channel;
					break;
				}
				if (voices[v].age >= oldestAge) {
					oldestAge = voices[v].age;
					oldest = v;
				}
			}
		}
		if (voice === -1) {
			if (!oldestAge) return -1;
			voiceOff(oldest);
			voice = oldest;
			voices[voice].channel = channel;
		}
		channels[channel].lastVoice = voice;
		return voice;
	};
	const noteOff = (channel: number, note: number): void => {
		for (let i = 0; i < VOICES; i++) {
			if (voices[i].channel === channel && voices[i].note === note) {
				if (channels[channel].holdPedal) voices[i].isSustained = true;
				else voiceOff(i);
				return;
			}
		}
	};
	const noteOn = (channel: number, note: number, velocityIn: number): void => {
		if (velocityIn === 0) return noteOff(channel, note);
		const velocity = velocityIn >> 1;
		if (note < 12 || note > 107) return;
		for (let i = 0; i < VOICES; i++) {
			if (voices[i].channel === channel && voices[i].note === note) {
				voiceOff(i);
				voiceOn(i, note, velocity);
				return;
			}
		}
		const voice = findVoice(channel);
		if (voice === -1) return;
		voiceOn(voice, note, velocity);
	};
	const renewNotes = (channel: number): void => {
		for (let i = 0; i < VOICES; i++) {
			if (voices[i].channel === channel && voices[i].note !== -1) setNote(i, voices[i].note, true);
		}
	};

	// driver start-up: rhythm off, waveform select on, then the track init from the header
	wr(0xbd, 0);
	wr(0x08, 0);
	wr(0x01, 0x20);
	for (let ch = 0; ch < 16; ch++) {
		channels[ch].patch = 13;
		if (wantedVoices[ch] > 0) assignVoices(ch, wantedVoices[ch]);
	}

	// ---- the event stream
	let p = 0;
	let ticks = 0;
	let status = 0;
	let loopTick = -1;
	const maxTicks = Math.floor((options.maxSeconds ?? 600) * TICK_HZ);
	let guard = 0;
	const at = (t: number): void => {
		log.time = (t / TICK_HZ) * TIMEBASE;
	};
	while (p < stream.length && ticks < maxTicks && guard++ < 1_000_000) {
		let delta = stream[p++];
		if (delta === 0xfc) break;
		while (delta === 0xf8 && p < stream.length) {
			ticks += 240;
			delta = stream[p++];
		}
		ticks += delta === 0xf8 ? 0 : delta;
		at(ticks);
		if (p >= stream.length) break;
		let b = stream[p++];
		if (b === 0xfc) break;
		if (b === 0xf0) {
			while (p < stream.length && stream[p++] !== 0xf7);
			continue;
		}
		let p1: number;
		if (b & 0x80) {
			status = b;
			p1 = stream[p++];
		} else {
			p1 = b;
			b = status;
		}
		const command = b & 0xf0;
		const channel = b & 15;
		const n = N_PARAMS[(command >> 4) - 8] ?? 0;
		const p2 = n === 2 ? stream[p++] : 0;
		if (!play[channel] || channel === 15) continue;
		switch (command) {
			case 0x80:
				noteOff(channel, p1);
				break;
			case 0x90:
				noteOn(channel, p1, p2);
				break;
			case 0xb0:
				if (p1 === 0x0a) {
					channels[channel].pan = p2;
					renewNotes(channel);
				} else if (p1 === 0x40) {
					channels[channel].holdPedal = p2;
					if (p2 === 0)
						for (let i = 0; i < VOICES; i++)
							if (voices[i].channel === channel && voices[i].isSustained) voiceOff(i);
				} else if (p1 === 0x4b) voiceMapping(channel, p2);
				else if (p1 === 0x4e) channels[channel].enableVelocity = p2 !== 0;
				else if (p1 === 0x7b) {
					for (let i = 0; i < VOICES; i++) {
						if (voices[i].channel === channel && voices[i].note !== -1) voiceOff(i);
					}
				} else if (p1 === 0x7f && loopTick < 0) loopTick = ticks;
				break;
			case 0xc0:
				channels[channel].patch = p1;
				break;
			case 0xe0:
				channels[channel].pitchWheel = (p1 & 0x7f) | ((p2 & 0x7f) << 7);
				renewNotes(channel);
				break;
		}
	}
	// notes still sounding at the end are released
	for (let i = 0; i < VOICES; i++) if (voices[i].note !== -1) voiceOff(i);
	at(ticks + TICK_HZ / 2);
	const data = log.build([{ id: 'opl2', clock: OPL_CLOCK }], TICK_HZ, 'Sierra SCI0 (AdLib)');
	if (loopTick >= 0) data.loopStart = Math.round((loopTick / TICK_HZ) * TIMEBASE);
	return data;
}

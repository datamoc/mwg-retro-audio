/**
 * Data model shared by the module formats (MOD, XM, IT, S3M): the parsers fill it, `TrackerPlayer` plays it.
 * Effects are stored with the FastTracker 2 effect numbering (0-0x23, `effects.ts`): the IT parser translates IT
 * commands into it, so a single engine plays every format.
 */

export interface Sample {
	name: string;
	/** sample data in -1..1, mono (stereo samples are mixed down) */
	data: Float32Array;
	/** 0 none, 1 forward, 2 ping-pong */
	loopType: 0 | 1 | 2;
	loopStart: number;
	loopEnd: number;
	/** default volume 0..64 */
	volume: number;
	/** MOD: finetune -8..7 (1/8 semitone); XM: -128..127 (1/128 semitone) */
	finetune: number;
	/** XM: relative note in semitones */
	relativeNote: number;
	/** playback rate of the reference note: 8363 for MOD / XM, the file's C5 speed for IT */
	baseFreq: number;
	/** default panning 0..255 or -1 for "use the channel's" */
	pan: number;
	/** IT sample vibrato (autovibrato) */
	vibrato?: { type: number; sweep: number; depth: number; rate: number };
}

export interface EnvelopePoint {
	tick: number;
	value: number;
}

export interface Envelope {
	enabled: boolean;
	points: EnvelopePoint[];
	sustain: boolean;
	sustainStart: number;
	sustainEnd: number;
	loop: boolean;
	loopStart: number;
	loopEnd: number;
	/** IT envelopes with the filter / pitch flag are stored but only volume and pan are applied */
	max: number;
}

export interface Instrument {
	name: string;
	samples: Sample[];
	/** note (0-95) -> index in `samples`; omitted = always 0 */
	sampleMap?: Uint8Array;
	volEnv?: Envelope;
	panEnv?: Envelope;
	pitchEnv?: Envelope;
	/** XM fadeout 0..32767 (units of 1/65536 per tick), IT 0..256 mapped to the same scale */
	fadeout: number;
	vibrato?: { type: number; sweep: number; depth: number; rate: number };
	/** IT new note action: 0 cut, 1 continue, 2 note off, 3 fade */
	nna?: number;
	/** IT default pan (-1 none) and pitch-pan separation are ignored: stored for completeness */
	defaultPan?: number;
	globalVolume?: number;
}

export interface Cell {
	/** 0 none, 1-96 note (C-0 = 1), 97 key off, 254 note cut (IT), 255 note fade (IT) */
	note: number;
	/** instrument number 1-based, 0 none; for MOD it is the sample number */
	instrument: number;
	/** volume column byte in the XM encoding (0 none, 0x10-0x50 set volume, 0x60.. effects) */
	volume: number;
	effect: number;
	param: number;
	/** MOD only: raw Amiga period of the note (0 none) */
	period?: number;
}

export interface Pattern {
	rows: number;
	/** `cells[row][channel]` */
	cells: Cell[][];
}

export interface TrackerSong {
	format: 'mod' | 'xm' | 'it' | 's3m';
	title: string;
	channels: number;
	patterns: Pattern[];
	/** pattern play order; 254 / 255 style markers are removed by the parsers */
	order: number[];
	restartPosition: number;
	initialSpeed: number;
	initialTempo: number;
	/** MOD and Amiga-mode XM: period based pitch with Paula clocks */
	amiga: boolean;
	/** XM / IT linear frequency table */
	linear: boolean;
	instruments: Instrument[];
	/** default pan 0..255 per channel */
	defaultPan: number[];
	/** default channel volume 0..64 (IT) */
	channelVolume: number[];
	globalVolume: number;
	/** file format flags: IT "old effects" and "compatible G" */
	itOldEffects?: boolean;
	/** MOD: samples live in `instruments[i].samples[0]` */
	notes?: string;
	/** Amiga file: true if the note frequencies should follow the Paula PAL (default) or NTSC clock */
	comment?: string;
}

export function emptyCell(): Cell {
	return { note: 0, instrument: 0, volume: 0, effect: 0, param: 0 };
}

export function makeEnvelope(
	points: EnvelopePoint[],
	flags: { on: boolean; sustain: boolean; loop: boolean },
	sustainStart: number,
	sustainEnd: number,
	loopStart: number,
	loopEnd: number,
): Envelope {
	return {
		enabled: flags.on && points.length > 0,
		points,
		sustain: flags.sustain,
		sustainStart,
		sustainEnd,
		loop: flags.loop,
		loopStart,
		loopEnd,
		max: 64,
	};
}

/**
 * Sound effect data model (specification section 6): an effect is data, a small program of register values per tick,
 * not an audio file. The curves are evaluated once per tick like the routine of the original game would.
 */

export type SfxChip =
	'ym2149' | 'ay8910' | 'sn76489' | 'nes' | 'sid' | 'opl2' | 'opl3' | 'ym2612' | 'pc-speaker' | 'saa1099';

/** A value per tick: a table, or a ramp with bounds, optionally looping */
export interface SfxCurve {
	/** table of values (one per tick); the last one is held unless `loopStart` is set */
	values?: number[];
	/** or: start value, step per tick, bounds */
	start?: number;
	step?: number;
	min?: number;
	max?: number;
	/** length in ticks (required for ramps, ignored for tables) */
	ticks?: number;
	/** index in `values` where playback loops back to (ping-pong when `pingPong`) */
	loopStart?: number;
	pingPong?: boolean;
}

/** FM operator and channel parameters of an OPL / OPN patch (raw register values, as written to the chip) */
export interface FmPatch {
	/** per operator: [AM/VIB/EGT/KSR/MULT, KSL/TL, AR/DR, SL/RR, waveform] for OPL; free form for other chips */
	operators: number[][];
	/** register C0 (OPL: feedback / connection) or B0 (OPN: feedback / algorithm) */
	feedbackConnection: number;
}

export interface SfxVoiceProgram {
	/** channel on the chip (0-based), or 'any' for the first one that can be taken */
	channel: number | 'any';
	/** pitch in fractional MIDI notes, OR the raw period / frequency register of the chip */
	pitch?: SfxCurve;
	rawPeriod?: SfxCurve;
	/** volume 0..15 normalised, OR the chip's native volume register value */
	volume?: SfxCurve;
	rawVolume?: SfxCurve;
	/** noise period in the chip's native units (AY 0-31, SN 0-7, NES 0-15) */
	noisePeriod?: SfxCurve;
	/** per tick switches: bit 0 tone, bit 1 noise, bit 2 hardware envelope */
	mix?: SfxCurve;
	/** pulse duty: NES 0-3, SID 0-4095 */
	duty?: SfxCurve;
	/** SID waveform bits (16 triangle, 32 saw, 64 pulse, 128 noise) and ADSR [attack, decay, sustain, release] */
	waveform?: number;
	adsr?: [number, number, number, number];
	/** hardware envelope (AY): register 11/12 period and register 13 shape, written at the first tick */
	envelope?: { period: number; shape: number };
	vibrato?: { depth: number; rate: number; delay?: number };
	arpeggio?: number[];
	/** raw register writes at a given tick: the escape hatch for everything not modelled above */
	writes?: { tick: number; reg: number; value: number }[];
	fm?: { patch: FmPatch; keyOnTick: number; keyOffTick?: number };
	sample?: { data: Int8Array | Uint8Array; rate: number; loop?: [number, number]; bits?: 4 | 8 };
}

export interface SfxDefinition {
	name: string;
	chip: SfxChip;
	/** driving rate in Hz; defaults to the region of the engine (50 / 60) */
	tickRate?: number;
	/** total length in ticks (default: until every curve is finished and the volume is zero) */
	length?: number;
	voices: SfxVoiceProgram[];
	/** a higher or equal priority effect takes the channel of a lower one; 0 is the music */
	priority: number;
	retrigger: 'restart' | 'stack' | 'ignore';
	pan?: number;
}

export interface SfxBank {
	name: string;
	region: 'PAL' | 'NTSC';
	effects: SfxDefinition[];
}

export interface SoundtrackProject {
	name: string;
	region: 'PAL' | 'NTSC';
	/** music files by id (paths or in-memory names) */
	music: Record<string, string>;
	bank: SfxBank;
	/** command numbers of the original sound driver mapped to music or effects */
	triggers: Record<number, { kind: 'music' | 'sfx'; id: string }>;
	samples?: Record<string, string>;
}

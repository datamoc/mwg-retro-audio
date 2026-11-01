/**
 * Retro-flavoured processing presets, in plain data: what a named preset asks for, independent of
 * how it is applied (a live Web Audio chain in `chain.ts`, an offline buffer pass in `pcm.ts`).
 *
 * These are stylistic effects for games, not emulator-accurate reproductions: they shape an
 * already-synthesised or sampled signal the way small speakers, low-bit converters and
 * sample-and-hold circuits of the era did. `CONFORMANCE.md` lists what each one changes.
 */

export type RetroEffectName =
	'none' | 'nes' | 'sid' | 'gameboy' | 'mega-drive' | 'adlib' | 'pc-speaker' | 'atari-st' | 'bitcrush' | 'lofi';

export interface RetroHighpass {
	/** cut-off in Hz */
	frequency: number;
	/** resonance, 0.707 when omitted */
	q?: number;
}

export interface RetroLowpass {
	/** cut-off in Hz */
	frequency: number;
	/** resonance, 0.707 when omitted */
	q?: number;
	/** 1 = 12 dB/oct, 2 = 24 dB/oct (default 1) */
	order?: 1 | 2;
}

export interface RetroBitcrush {
	/** converter resolution in bits (1 to 24) */
	bits: number;
	/** pre-quantisation saturation, 1 = none (default) */
	drive?: number;
}

export interface RetroSampleRateReduction {
	/** sample-and-hold rate in Hz */
	rate: number;
}

/** the DAC non-linearity already modelled by `OutputStage` */
export interface RetroDac {
	/** converter resolution in bits (1 to 24) */
	bits?: number;
	/** dead band around zero, fraction of full scale (0 to 1) */
	crossover?: number;
}

export interface RetroEffectPreset {
	/** identifier used by `retroEffects()`; custom presets may use any non-empty name */
	name: string;
	/** short human name for a menu */
	label: string;
	/** one sentence for documentation and tooltips */
	description: string;
	highpass?: RetroHighpass;
	lowpass?: RetroLowpass;
	bitcrush?: RetroBitcrush;
	sampleRateReduction?: RetroSampleRateReduction;
	dac?: RetroDac;
	/** final linear gain, 1 when omitted */
	gain?: number;
}

const DEFAULT_Q = Math.SQRT1_2;

export const RETRO_EFFECT_PRESETS: Readonly<Record<RetroEffectName, RetroEffectPreset>> = Object.freeze({
	none: {
		name: 'none',
		label: 'Dry',
		description: 'No processing.',
	},
	nes: {
		name: 'nes',
		label: 'NES / Famicom',
		description: '8-bit converter, 22 kHz sample-and-hold and the console output low-pass.',
		sampleRateReduction: { rate: 22050 },
		bitcrush: { bits: 8 },
		lowpass: { frequency: 14000, q: DEFAULT_Q, order: 2 },
	},
	sid: {
		name: 'sid',
		label: 'MOS SID',
		description: '8-bit converter, 16 kHz sample-and-hold and the SID analogue low-pass.',
		sampleRateReduction: { rate: 16000 },
		bitcrush: { bits: 8 },
		lowpass: { frequency: 8000, q: 1, order: 2 },
	},
	gameboy: {
		name: 'gameboy',
		label: 'Game Boy',
		description: '4-bit converter, 12 kHz sample-and-hold and the small-speaker low-pass.',
		sampleRateReduction: { rate: 12000 },
		bitcrush: { bits: 4 },
		lowpass: { frequency: 6000, q: DEFAULT_Q, order: 2 },
	},
	'mega-drive': {
		name: 'mega-drive',
		label: 'Mega Drive',
		description: 'YM2612 9-bit ladder DAC with its dead band and the console low-pass.',
		dac: { bits: 9, crossover: 0.01 },
		lowpass: { frequency: 3390, q: DEFAULT_Q, order: 1 },
	},
	adlib: {
		name: 'adlib',
		label: 'AdLib / OPL',
		description: 'OPL 9-bit DAC with its dead band and a gentle anti-aliasing low-pass.',
		dac: { bits: 9, crossover: 0.004 },
		lowpass: { frequency: 16000, q: DEFAULT_Q, order: 1 },
	},
	'pc-speaker': {
		name: 'pc-speaker',
		label: 'PC speaker',
		description: 'Small PC speaker: no bass and nothing above about 5 kHz.',
		highpass: { frequency: 300, q: DEFAULT_Q },
		lowpass: { frequency: 5000, q: DEFAULT_Q, order: 2 },
	},
	'atari-st': {
		name: 'atari-st',
		label: 'Atari ST',
		description: 'ST monitor output: DC block at 14 Hz and a 15 kHz low-pass.',
		highpass: { frequency: 14, q: DEFAULT_Q },
		lowpass: { frequency: 15000, q: DEFAULT_Q, order: 1 },
	},
	bitcrush: {
		name: 'bitcrush',
		label: 'Bitcrush',
		description: '6-bit quantisation and 11 kHz sample-and-hold, without a filter.',
		bitcrush: { bits: 6 },
		sampleRateReduction: { rate: 11025 },
	},
	lofi: {
		name: 'lofi',
		label: 'Lo-fi',
		description: '8-bit quantisation, 16 kHz sample-and-hold and an 8 kHz low-pass.',
		bitcrush: { bits: 8 },
		sampleRateReduction: { rate: 16000 },
		lowpass: { frequency: 8000, q: DEFAULT_Q, order: 1 },
	},
} satisfies Record<RetroEffectName, RetroEffectPreset>);

for (const preset of Object.values(RETRO_EFFECT_PRESETS)) {
	Object.freeze(preset);
	if (preset.highpass) Object.freeze(preset.highpass);
	if (preset.lowpass) Object.freeze(preset.lowpass);
	if (preset.bitcrush) Object.freeze(preset.bitcrush);
	if (preset.sampleRateReduction) Object.freeze(preset.sampleRateReduction);
	if (preset.dac) Object.freeze(preset.dac);
}

const PRESET_NAMES = Object.freeze(Object.keys(RETRO_EFFECT_PRESETS) as RetroEffectName[]);

/** every built-in preset name, in declaration order */
export function retroEffectNames(): readonly RetroEffectName[] {
	return PRESET_NAMES;
}

/** resolve a preset by name, or validate and freeze a custom one */
export function retroEffects(preset: RetroEffectName | RetroEffectPreset): RetroEffectPreset {
	if (typeof preset === 'string') {
		const found = RETRO_EFFECT_PRESETS[preset as RetroEffectName];
		if (!found) throw new RangeError(`unknown retro effect '${preset}'; known effects: ${PRESET_NAMES.join(', ')}`);
		return found;
	}
	return validatePreset(preset);
}

function assertPositive(value: number | undefined, label: string): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive finite number`);
}

function assertBits(value: number | undefined, label: string): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 1 || value > 24)
		throw new RangeError(`${label} must be an integer between 1 and 24`);
}

function validatePreset(preset: RetroEffectPreset): RetroEffectPreset {
	if (typeof preset.name !== 'string' || !preset.name.trim())
		throw new RangeError('a retro effect preset needs a non-empty name');
	if (typeof preset.label !== 'string' || !preset.label.trim())
		throw new RangeError(`retro effect '${preset.name}' needs a label`);
	if (typeof preset.description !== 'string')
		throw new RangeError(`retro effect '${preset.name}' needs a description`);
	const { highpass, lowpass, bitcrush, sampleRateReduction, dac } = preset;
	if (highpass) {
		assertPositive(highpass.frequency, 'highpass.frequency');
		assertPositive(highpass.q, 'highpass.q');
	}
	if (lowpass) {
		assertPositive(lowpass.frequency, 'lowpass.frequency');
		assertPositive(lowpass.q, 'lowpass.q');
		if (lowpass.order !== undefined && lowpass.order !== 1 && lowpass.order !== 2)
			throw new RangeError('lowpass.order must be 1 or 2');
	}
	if (bitcrush) {
		assertBits(bitcrush.bits, 'bitcrush.bits');
		assertPositive(bitcrush.drive, 'bitcrush.drive');
	}
	if (sampleRateReduction) assertPositive(sampleRateReduction.rate, 'sampleRateReduction.rate');
	if (dac) {
		assertBits(dac.bits, 'dac.bits');
		if (dac.crossover !== undefined && (!Number.isFinite(dac.crossover) || dac.crossover < 0 || dac.crossover > 1))
			throw new RangeError('dac.crossover must be between 0 and 1');
	}
	if (preset.gain !== undefined && (!Number.isFinite(preset.gain) || preset.gain < 0))
		throw new RangeError('gain must be a positive finite number');
	const result: RetroEffectPreset = {
		name: preset.name,
		label: preset.label,
		description: preset.description,
	};
	if (highpass) result.highpass = Object.freeze({ ...highpass });
	if (lowpass) result.lowpass = Object.freeze({ ...lowpass });
	if (bitcrush) result.bitcrush = Object.freeze({ ...bitcrush });
	if (sampleRateReduction) result.sampleRateReduction = Object.freeze({ ...sampleRateReduction });
	if (dac) result.dac = Object.freeze({ ...dac });
	if (preset.gain !== undefined) result.gain = preset.gain;
	return Object.freeze(result);
}

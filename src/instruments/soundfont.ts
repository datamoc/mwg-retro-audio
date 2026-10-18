import { SoundFontSynth } from '../chips/SoundFont.ts';
import type { SoundFont } from '../formats/soundfont.ts';
import { SynthInstrument } from './SynthInstrument.ts';
import type { InstrumentDef, InstrumentInfo } from './Instrument.ts';
import { rangeControl, toggleControl, param } from './controls.ts';

/**
 * The presets of a SoundFont 2 bank as playable instruments, one per preset. A bank is the user's own file and is only
 * known at run time, so these definitions are made on demand and are not part of the static catalogue: a page adds
 * them to its list (the piano demo does), and `instrumentMidiEngines(soundFontInstruments(...))` from `mwg` makes each
 * a named MIDI engine (`retro:soundfont:<bank>:<n>`). No sample ships with the package: the samples are the bank's.
 */

/** a short, stable identifier for a bank from its name or file name: lower case letters, digits and hyphens */
export function soundFontBankId(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/\.(sf2|sf3)$/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'bank';
}

export function soundFontInstruments(font: SoundFont, bankId = soundFontBankId(font.name)): InstrumentDef[] {
	return font.presets.map((preset, index) => {
		const info: InstrumentInfo = {
			id: `soundfont:${bankId}:${index}`,
			name: `${preset.name || `Preset ${index}`} (${font.name})`,
			family: 'sampler',
			era: `SoundFont ${font.version}, bank ${preset.bank} program ${preset.program}`,
			description:
				'A preset of a SoundFont 2 bank opened by the user: the samples are the bank’s own. Zones, key and velocity ranges, loops, tuning, attenuation, pan, the volume envelope and the filter cut-off are played; modulators, LFOs and effects are not.',
			polyphony: 32,
		};
		return {
			info,
			create: (options) =>
				new SynthInstrument(
					info,
					new SoundFontSynth(font, { ...options, preset: index }),
					(instrument) => {
						const chip = instrument.chip;
						const gain = param(chip.gainDb);
						const pan = param(chip.panOffset * 100);
						const attack = param(chip.attackScale);
						const release = param(chip.releaseScale);
						instrument.controls.push(
							rangeControl(
								{
									id: 'gain',
									label: 'Gain',
									group: 'Output',
									min: -24,
									max: 12,
									step: 0.5,
									unit: 'dB',
								},
								gain,
								(value) => {
									chip.gainDb = value;
								},
							),
							rangeControl(
								{
									id: 'pan',
									label: 'Pan offset',
									group: 'Output',
									min: -50,
									max: 50,
									step: 1,
									unit: '%',
								},
								pan,
								(value) => {
									chip.panOffset = value / 100;
								},
							),
							rangeControl(
								{
									id: 'attack',
									label: 'Attack time',
									group: 'Envelope',
									min: 0.1,
									max: 4,
									step: 0.1,
									unit: '×',
									hint: 'Multiplies the attack time of every zone',
								},
								attack,
								(value) => {
									chip.attackScale = value;
								},
							),
							rangeControl(
								{
									id: 'release',
									label: 'Release time',
									group: 'Envelope',
									min: 0.1,
									max: 4,
									step: 0.1,
									unit: '×',
									hint: 'Multiplies the release time of every zone',
								},
								release,
								(value) => {
									chip.releaseScale = value;
								},
							),
							toggleControl(
								{
									id: 'filter',
									label: 'Filter',
									group: 'Sample',
									hint: 'The low-pass cut-off of the zones',
								},
								param(chip.useFilter),
								(value) => {
									chip.useFilter = value;
								},
							),
							toggleControl(
								{ id: 'loops', label: 'Loops', group: 'Sample', hint: 'Sustain the looped samples' },
								param(chip.useLoops),
								(value) => {
									chip.useLoops = value;
								},
							),
						);
					},
					options,
				),
		};
	});
}

import { D50Synth, D50_PRESETS, Gs1, GS1_PRESETS, Vl1 } from '../chips/historical.ts';
import { M1Synth, M1_PRESETS } from '../chips/M1.ts';
import { Dx7Synth } from '../chips/Dx7.ts';
import { parseDx7Voice } from '../formats/dx7.ts';
import type { InstrumentDef } from './Instrument.ts';
import { choiceControl, labelled, param } from './controls.ts';

import { definition } from './SynthInstrument.ts';

export const historicalInstruments: readonly InstrumentDef[] = [
	definition(
		'd50',
		'Roland D-50',
		'1987',
		16,
		(options) => new D50Synth(options),
		(instrument) => {
			instrument.presetChoice(
				D50_PRESETS.map((preset) => preset.name),
				(index) => {
					const patch = structuredClone(D50_PRESETS[index].patch);
					instrument.chip.loadPatch(patch);
					instrument.number(
						'release',
						'Relâchement',
						0.01,
						5,
						0.01,
						() => patch.release ?? 0.3,
						(value) => {
							patch.release = value;
						},
						's',
					);
					patch.tones.forEach((tone, t) => {
						instrument.number(
							`tone${t}.structure`,
							`Tone ${t + 1} : structure`,
							1,
							7,
							1,
							() => tone.structure ?? 1,
							(value) => {
								tone.structure = value;
							},
						);
						tone.partials.forEach((partial, p) => {
							const prefix = `Tone ${t + 1}, partiel ${p + 1}`;
							instrument.number(
								`tone${t}.${p}.level`,
								`${prefix} : niveau`,
								0,
								1,
								0.01,
								() => partial.level ?? 1,
								(value) => {
									partial.level = value;
								},
							);
							instrument.number(
								`tone${t}.${p}.cutoff`,
								`${prefix} : coupure`,
								20,
								20000,
								10,
								() => partial.cutoff,
								(value) => {
									partial.cutoff = value;
								},
								'Hz',
							);
							instrument.number(
								`tone${t}.${p}.detune`,
								`${prefix} : désaccord`,
								-100,
								100,
								1,
								() => partial.detuneCents ?? 0,
								(value) => {
									partial.detuneCents = value;
								},
								'cents',
							);
						});
					});
				},
			);
		},
	),
	definition(
		'm1',
		'Korg M1',
		'1988',
		16,
		(options) => new M1Synth(options),
		(instrument) => {
			instrument.presetChoice(
				M1_PRESETS.map((preset) => preset.name),
				(index) => {
					const program = structuredClone(M1_PRESETS[index].program);
					instrument.chip.loadProgram(program);
					instrument.number(
						'cutoff',
						'Filtre : coupure',
						20,
						20000,
						10,
						() => program.cutoff,
						(value) => {
							program.cutoff = value;
						},
						'Hz',
					);
					instrument.number(
						'resonance',
						'Filtre : résonance',
						0,
						1,
						0.01,
						() => program.resonance ?? 0,
						(value) => {
							program.resonance = value;
						},
					);
					instrument.number(
						'release',
						'Relâchement',
						0.01,
						5,
						0.01,
						() => program.release ?? 0.3,
						(value) => {
							program.release = value;
						},
						's',
					);
					program.oscs.forEach((oscillator, index) => {
						instrument.number(
							`osc${index}.level`,
							`Oscillateur ${index + 1} : niveau`,
							0,
							1,
							0.01,
							() => oscillator.level ?? 1,
							(value) => {
								oscillator.level = value;
							},
						);
						instrument.number(
							`osc${index}.detune`,
							`Oscillateur ${index + 1} : désaccord`,
							-100,
							100,
							1,
							() => oscillator.detuneCents ?? 0,
							(value) => {
								oscillator.detuneCents = value;
							},
							'cents',
						);
					});
				},
			);
		},
	),
	definition(
		'gs1',
		'Yamaha GS-1',
		'1981',
		16,
		(options) => new Gs1(options),
		(instrument) => {
			instrument.presetChoice(
				GS1_PRESETS.map((preset) => preset.name),
				(index) => {
					const patch = structuredClone(GS1_PRESETS[index].patch);
					instrument.chip.loadPatch(patch);
					patch.pairs.forEach((pair, index) => {
						instrument.number(
							`pair${index}.ratio`,
							`Paire ${index + 1} : rapport porteur`,
							0.25,
							16,
							0.25,
							() => pair.carrierRatio,
							(value) => {
								pair.carrierRatio = value;
							},
						);
						instrument.number(
							`pair${index}.index`,
							`Paire ${index + 1} : indice FM`,
							0,
							20,
							0.1,
							() => pair.modIndex,
							(value) => {
								pair.modIndex = value;
							},
						);
					});
				},
			);
		},
	),
	definition(
		'vl1',
		'Casio VL-1',
		'1979',
		1,
		(options) => new Vl1(options),
		(instrument) => {
			instrument.chip.sound = 'piano';
			instrument.chip.adsr = { attack: 0, decay: 5, sustain: 5, release: 5 };
			instrument.chip.vibrato = 0;
			const names = ['piano', 'fantasy', 'violin', 'flute', 'guitar', 'electric piano', 'adsr'] as const;
			instrument.controls.push(
				choiceControl({ id: 'sound', label: 'Son' }, labelled(names), param(0), (index) => {
					instrument.chip.sound = names[index];
				}),
			);
			for (const key of ['attack', 'decay', 'sustain', 'release'] as const)
				instrument.number(
					key,
					`ADSR : ${key}`,
					0,
					9,
					1,
					() => instrument.chip.adsr[key],
					(value) => {
						instrument.chip.adsr[key] = value;
					},
				);
			instrument.number(
				'vibrato',
				'Vibrato',
				0,
				1,
				0.01,
				() => instrument.chip.vibrato,
				(value) => {
					instrument.chip.vibrato = value;
				},
			);
		},
	),
	definition(
		'dx7',
		'Yamaha DX7',
		'1983',
		16,
		(options) => new Dx7Synth(options),
		(instrument) => {
			const voice = parseDx7Voice(new Uint8Array(128));
			voice.algorithm = 31;
			voice.pitchEgLevels = [50, 50, 50, 50];
			voice.pitchEgRates = [99, 99, 99, 99];
			voice.transpose = 24;
			voice.operators.forEach((operator, index) => {
				operator.rates = [99, 70, 70, 60];
				operator.levels = [99, 80, 80, 0];
				operator.detune = 7;
				operator.freqCoarse = 1;
				operator.outputLevel = index === 5 ? 99 : 0;
				instrument.number(
					`op${index}.level`,
					`Opérateur ${6 - index} : niveau`,
					0,
					99,
					1,
					() => operator.outputLevel,
					(value) => {
						operator.outputLevel = value;
					},
				);
				instrument.number(
					`op${index}.ratio`,
					`Opérateur ${6 - index} : fréquence grossière`,
					0,
					31,
					1,
					() => operator.freqCoarse,
					(value) => {
						operator.freqCoarse = value;
					},
				);
			});
			instrument.number(
				'algorithm',
				'Algorithme (index 0–31)',
				0,
				31,
				1,
				() => voice.algorithm,
				(value) => {
					voice.algorithm = value;
				},
			);
			instrument.number(
				'feedback',
				'Feedback',
				0,
				7,
				1,
				() => voice.feedback,
				(value) => {
					voice.feedback = value;
				},
			);
			instrument.chip.loadVoice(voice);
		},
	),
];

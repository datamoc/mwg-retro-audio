import {
	AdditiveSynth,
	Synclavier,
	LaSynth,
	AiSynth,
	type AdditivePatch,
	type SynclavierPatch,
	type FilterVoiceParams,
} from '../chips/historical.ts';
import { Mt32Synth } from '../chips/Mt32Synth.ts';
import { definition } from './SynthInstrument.ts';
import { choiceControl, labelled, param } from './controls.ts';
import type { InstrumentDef } from './Instrument.ts';

/** A note facade keeps the actual MT-32 renderer and its melodic part together. */
class PlayableMt32 extends Mt32Synth {
	noteOn(note: number, velocity = 100): void {
		this.event(0x91, note, velocity);
	}
	noteOff(note: number): void {
		this.event(0x81, note, 0);
	}
}

export const modelledInstruments: readonly InstrumentDef[] = [
	...(['bellLabs', 'dartmouth'] as const).map((preset) =>
		definition(
			preset === 'bellLabs' ? 'additive' : 'dartmouth',
			preset === 'bellLabs' ? 'Bell Labs Digital Synthesizer' : 'Dartmouth Digital Synthesizer',
			preset === 'bellLabs' ? '1977' : '1972',
			preset === 'bellLabs' ? 8 : 4,
			(options) => new AdditiveSynth({ ...options, preset }),
			(instrument) => {
				const patch: AdditivePatch = {
					release: 0.3,
					partials: Array.from({ length: 4 }, (_, index) => ({
						ratio: index + 1,
						amp: [
							[0, 0],
							[0.01, 1 / (index + 1)],
							[1, 0.5 / (index + 1)],
						],
					})),
				};
				instrument.chip.loadPatch(patch);
				patch.partials.forEach((partial, index) => {
					instrument.number(
						`partial${index}.ratio`,
						`Partiel ${index + 1} : rapport`,
						0.25,
						16,
						0.25,
						() => partial.ratio,
						(value) => {
							partial.ratio = value;
						},
					);
				});
				instrument.number(
					'release',
					'Relâchement',
					0.01,
					5,
					0.01,
					() => patch.release!,
					(value) => {
						patch.release = value;
					},
					's',
				);
			},
		),
	),
	definition(
		'synclavier',
		'Synclavier',
		'1977',
		8,
		(options) => new Synclavier(options),
		(instrument) => {
			const patch: SynclavierPatch = {
				release: 0.3,
				partials: [
					{
						harmonics: [1, 0.5, 0.25, 0.1],
						fmIndex: 0,
						fmRatio: 1,
						amp: [
							[0, 0],
							[0.01, 1],
							[1, 0.7],
						],
					},
				],
			};
			instrument.chip.loadPatch(patch);
			const partial = patch.partials[0];
			partial.harmonics.forEach((_, index) =>
				instrument.number(
					`harmonic${index}`,
					`Harmonique ${index + 1}`,
					0,
					1,
					0.01,
					() => partial.harmonics[index],
					(value) => {
						partial.harmonics[index] = value;
					},
				),
			);
			instrument.number(
				'fmIndex',
				'Indice FM',
				0,
				20,
				0.1,
				() => partial.fmIndex!,
				(value) => {
					partial.fmIndex = value;
				},
			);
			instrument.number(
				'fmRatio',
				'Rapport FM',
				0.25,
				16,
				0.25,
				() => partial.fmRatio!,
				(value) => {
					partial.fmRatio = value;
				},
			);
		},
	),
	...(['la-synth', 'ai-synth'] as const).map((id) =>
		definition(
			id,
			id === 'la-synth' ? 'Structure LA' : 'Structure AI',
			'1987–1988',
			8,
			(options) => (id === 'la-synth' ? new LaSynth(options) : new AiSynth(options)),
			(instrument) => {
				const partial: FilterVoiceParams = {
					wave: 'saw',
					cutoff: 2000,
					resonance: 0.1,
					pulseWidth: 0.5,
					amp: [
						[0, 0],
						[0.01, 1],
						[1, 0.7],
					],
					release: 0.3,
				};
				instrument.chip.loadPatch([partial]);
				const waves = ['saw', 'square', 'noise'] as const;
				instrument.controls.push(
					choiceControl({ id: 'wave', label: 'Oscillateur : onde' }, labelled(waves), param(0), (index) => {
						partial.wave = waves[index];
					}),
				);
				instrument.number(
					'cutoff',
					'Filtre : coupure',
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
					'resonance',
					'Filtre : résonance',
					0,
					1,
					0.01,
					() => partial.resonance!,
					(value) => {
						partial.resonance = value;
					},
				);
				instrument.number(
					'pulseWidth',
					'Largeur d’impulsion',
					0.05,
					0.95,
					0.01,
					() => partial.pulseWidth!,
					(value) => {
						partial.pulseWidth = value;
					},
				);
				instrument.number(
					'release',
					'Relâchement',
					0.01,
					5,
					0.01,
					() => partial.release!,
					(value) => {
						partial.release = value;
					},
					's',
				);
			},
		),
	),
	definition(
		'mt32',
		'Roland MT-32',
		'1987',
		16,
		(options) => new PlayableMt32(options.sampleRate),
		(instrument) => {
			instrument.chip.reset();
			instrument.controls.push(
				choiceControl(
					{ id: 'program', label: 'Programme MT-32 (familles approchées)' },
					labelled(Array.from({ length: 128 }, (_, index) => String(index + 1))),
					param(0),
					(index) => instrument.chip.event(0xc1, index, 0),
				),
			);
		},
	),
];

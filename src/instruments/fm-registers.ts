import type { Chip } from '../chips/Chip.ts';
import { Opl } from '../chips/Opl.ts';
import { Opn } from '../chips/Opn.ts';
import { SoundBlasterCard } from '../chips/cards.ts';
import { Ym2151 } from '../chips/Ym2151.ts';
import { Ym2612 } from '../chips/Ym2612.ts';
import { RegisterInstrument } from './RegisterInstrument.ts';
import { choiceControl, labelled, param, rangeControl } from './controls.ts';
import type { InstrumentDef, InstrumentInfo, InstrumentOptions } from './Instrument.ts';

const MUL_LABELS = [
	'1/1',
	'2/1',
	'4/1',
	'6/1',
	'8/1',
	'10/1',
	'12/1',
	'14/1',
	'16/1',
	'18/1',
	'20/1',
	'22/1',
	'24/1',
	'26/1',
	'28/1',
	'30/1',
];

export const oplInstruments: readonly InstrumentDef[] = ['opl2', 'opl3', 'sound-blaster'].map((id) => {
	const info: InstrumentInfo = {
		id,
		name: id === 'sound-blaster' ? 'Sound Blaster (OPL2)' : id.toUpperCase(),
		family: id === 'sound-blaster' ? 'card' : 'fm',
		era: '1985–1991',
		polyphony: id === 'opl3' ? 18 : 9,
		description:
			'Synthèse FM à deux opérateurs sur les registres OPL ; enveloppe matérielle, niveau modulateur et rapport de fréquences. Les changements de timbre s’appliquent à la prochaine note.',
	};
	return {
		info,
		create(options) {
			let chip: Chip;
			let write: (register: number, value: number) => void;
			let rate: number;
			if (id === 'sound-blaster') {
				const card = new SoundBlasterCard(options);
				chip = card;
				const opl = card.parts.find((part) => part instanceof Opl) as Opl;
				rate = opl.nativeRate;
				write = (register, value) => {
					card.write(0x388, register);
					card.write(0x389, value);
				};
			} else {
				const opl = new Opl({ ...options, variant: id === 'opl3' ? 'opl3' : 'opl2' });
				chip = opl;
				rate = opl.nativeRate;
				write = (register, value) => opl.write(register, value);
			}
			const upper = new Uint8Array(18);
			const modLevel = param(24),
				ratio = param(1),
				feedback = param(0);
			const register = (channel: number, base: number): number =>
				(channel >= 9 ? 0x100 : 0) + base + (channel % 9);
			const slot = (channel: number): number =>
				[0, 1, 2, 8, 9, 10, 16, 17, 18][channel % 9] + (channel >= 9 ? 0x100 : 0);
			const pitch = (channel: number, hz: number): void => {
				let block = 0,
					fnum = (hz * 2 ** 20) / rate;
				while (fnum > 1023 && block < 7) {
					block++;
					fnum /= 2;
				}
				const value = Math.max(0, Math.min(1023, Math.round(fnum)));
				upper[channel] = (block << 2) | (value >> 8);
				write(register(channel, 0xa0), value & 255);
				write(register(channel, 0xb0), 0x20 | upper[channel]);
			};
			return new RegisterInstrument(
				info,
				chip,
				{
					controls: [
						rangeControl(
							{ id: 'modLevel', label: 'Modulateur : atténuation', min: 0, max: 63, step: 1 },
							modLevel,
						),
						rangeControl(
							{ id: 'ratio', label: 'Modulateur : multiplicateur', min: 0, max: 15, step: 1 },
							ratio,
						),
						rangeControl({ id: 'feedback', label: 'Feedback', min: 0, max: 7, step: 1 }, feedback),
					],
					restore() {
						write(1, 0x20);
						if (id === 'opl3') write(0x105, 1);
					},
					pitch,
					start(channel, hz, velocity) {
						const mod = slot(channel),
							carrier = mod + 3;
						write(register(channel, 0xb0), upper[channel]);
						write(0x20 + mod, 0x20 | ratio.value);
						write(0x20 + carrier, 0x21);
						write(0x40 + mod, modLevel.value);
						write(0x40 + carrier, Math.round(30 * (1 - velocity / 127)));
						for (const operator of [mod, carrier]) {
							write(0x60 + operator, 0xf2);
							write(0x80 + operator, 0x46);
						}
						write(register(channel, 0xc0), 0x30 | (feedback.value << 1));
						pitch(channel, hz);
					},
					stop: (channel) => write(register(channel, 0xb0), upper[channel]),
				},
				options,
			);
		},
	};
});

/** YM2612 (Mega Drive), YM2203 (OPN) and YM2608 (OPNA): the 4-operator family, used here as two 2-operator pairs. */
function opnDefinition(
	id: string,
	name: string,
	era: string,
	polyphony: number,
	description: string,
	rateOf: (chip: Chip) => number,
): InstrumentDef {
	const info: InstrumentInfo = { id, name, family: 'fm', era, polyphony, description };
	return {
		info,
		create(options) {
			const chip: Chip =
				id === 'ym2612'
					? new Ym2612(options)
					: new Opn({ ...options, variant: id === 'ym2203' ? 'ym2203' : 'ym2608' });
			const rate = rateOf(chip);
			const ratio = param(1),
				modLevel = param(20),
				feedback = param(0);
			const slot = (channel: number, offset: number, value: number): void => {
				chip.write((channel >= 3 ? 0x100 : 0) | (offset + (channel % 3)), value);
			};
			const pitch = (channel: number, hz: number): void => {
				let block = 0,
					fnum = (hz * 2 ** 21) / rate;
				while (fnum > 1023 && block < 7) {
					block++;
					fnum /= 2;
				}
				fnum = Math.max(0, Math.min(1023, Math.round(fnum)));
				slot(channel, 0xa4, (block << 3) | (fnum >> 8));
				slot(channel, 0xa0, fnum & 255);
			};
			const key = (channel: number, on: boolean): void => {
				chip.write(0x28, (channel < 3 ? channel : channel + 1) | (on ? 0x50 : 0));
			};
			return new RegisterInstrument(
				info,
				chip,
				{
					controls: [
						choiceControl(
							{ id: 'ratio', label: 'Modulateur : multiplicateur' },
							labelled(MUL_LABELS),
							ratio,
						),
						rangeControl(
							{ id: 'modLevel', label: 'Modulateur : atténuation', min: 0, max: 127, step: 1 },
							modLevel,
						),
						rangeControl({ id: 'feedback', label: 'Feedback', min: 0, max: 7, step: 1 }, feedback),
					],
					pitch,
					start(channel, hz, velocity) {
						slot(channel, 0xb0, (feedback.value << 3) | 4);
						slot(channel, 0xb4, 0xc0);
						slot(channel, 0x30, ratio.value & 15);
						slot(channel, 0x38, 1); // carrier at the note itself (a multiplier of 0 is half)
						slot(channel, 0x44, 0x7f);
						slot(channel, 0x4c, 0x7f);
						slot(channel, 0x40, modLevel.value);
						slot(channel, 0x48, Math.round(18 * (1 - velocity / 127)));
						slot(channel, 0x50, 0x1f);
						slot(channel, 0x58, 0x1f);
						slot(channel, 0x60, 0);
						slot(channel, 0x68, 0);
						slot(channel, 0x70, 0);
						slot(channel, 0x78, 0);
						slot(channel, 0x80, 0x0f);
						slot(channel, 0x88, 0x0f);
						key(channel, true);
						pitch(channel, hz);
					},
					stop: (channel) => key(channel, false),
					restore() {
						chip.write(0x27, 0);
						chip.write(0x2b, 0);
					},
				},
				options,
			);
		},
	};
}

export const opnInstruments: readonly InstrumentDef[] = [
	opnDefinition(
		'ym2612',
		'Yamaha YM2612 (Mega Drive)',
		'1988',
		6,
		'Six canaux FM du YM2612, joués en paires de deux opérateurs (algorithme 4) ; enveloppes matérielles ADSR.',
		(chip) => (chip as Ym2612).nativeRate,
	),
	opnDefinition(
		'ym2203',
		'Yamaha YM2203 (OPN)',
		'1983',
		3,
		'Trois canaux FM de l’OPN des Sharp X68000 et NEC PC-88, en paires de deux opérateurs ; la partie SSG n’est pas jouable ici.',
		(chip) => chip.clock / 72,
	),
	opnDefinition(
		'ym2608',
		'Yamaha YM2608 (OPNA)',
		'1985',
		6,
		'Six canaux FM de l’OPNA des PC-98, en paires de deux opérateurs ; rythme et ADPCM hors jeu de note.',
		(chip) => chip.clock / 144,
	),
];

const OPM_SEMI = [1, 2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 9, 10, 11, 12, 12];
const opmSemi = (key: number): number => ((key >> 4) & 7) * 12 + OPM_SEMI[key & 15];

export const opmInstruments: readonly InstrumentDef[] = [
	{
		info: {
			id: 'ym2151',
			name: 'Yamaha YM2151 (OPM)',
			family: 'fm',
			era: '1983',
			polyphony: 8,
			description:
				'Huit canaux FM du YM2151 (arcades, DX21, TX81Z, Mega-Play), joués en paires de deux opérateurs ; hauteur en code de note + fraction, comme la machine.',
		},
		create(options: InstrumentOptions) {
			const chip = new Ym2151(options);
			const ratio = param(0),
				modLevel = param(20),
				feedback = param(0);
			const slot = (channel: number, group: number, type: number, value: number): void => {
				chip.write(type + group + channel, value);
			};
			const pitch = (channel: number, hz: number): void => {
				const target = 57 + 12 * Math.log2((hz * 3_579_545) / (440 * chip.clock));
				let best = 8;
				for (let key = 8; key < 128; key++)
					if (opmSemi(key) <= target && opmSemi(key) > opmSemi(best)) best = key;
				const fraction = Math.max(0, Math.min(63, Math.round((target - opmSemi(best)) * 64)));
				chip.write(0x28 + channel, best);
				chip.write(0x30 + channel, fraction << 2);
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					controls: [
						choiceControl(
							{ id: 'ratio', label: 'Modulateur : multiplicateur' },
							labelled(MUL_LABELS),
							ratio,
						),
						rangeControl(
							{ id: 'modLevel', label: 'Modulateur : atténuation', min: 0, max: 127, step: 1 },
							modLevel,
						),
						rangeControl({ id: 'feedback', label: 'Feedback', min: 0, max: 7, step: 1 }, feedback),
					],
					pitch,
					start(channel, hz, velocity) {
						chip.write(0x20 + channel, 0xc0 | (feedback.value << 3) | 4);
						slot(channel, 0x00, 0x40, ratio.value & 15);
						slot(channel, 0x10, 0x40, 0);
						slot(channel, 0x08, 0x60, 0x7f);
						slot(channel, 0x18, 0x60, 0x7f);
						slot(channel, 0x00, 0x60, modLevel.value);
						slot(channel, 0x10, 0x60, Math.round(18 * (1 - velocity / 127)));
						slot(channel, 0x00, 0x80, 31);
						slot(channel, 0x10, 0x80, 31);
						slot(channel, 0x00, 0xa0, 0);
						slot(channel, 0x10, 0xa0, 0);
						slot(channel, 0x00, 0xc0, 0);
						slot(channel, 0x10, 0xc0, 0);
						slot(channel, 0x00, 0xe0, 0x0f);
						slot(channel, 0x10, 0xe0, 0x0f);
						chip.write(0x08, channel | 0x28);
						pitch(channel, hz);
					},
					stop: (channel) => chip.write(0x08, channel),
				},
				options,
			);
		},
	},
];

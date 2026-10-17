import { Sn76489 } from '../chips/Sn76489.ts';
import { Sid } from '../chips/Sid.ts';
import { NesApu } from '../chips/NesApu.ts';
import { Mmc5, Sunsoft5b, Vrc6 } from '../chips/NesExpansion.ts';
import { Fds, Namco163 } from '../chips/NesExpansion2.ts';
import { RegisterInstrument } from './RegisterInstrument.ts';
import type { InstrumentDef, InstrumentInfo } from './Instrument.ts';
import { choiceControl, labelled, param, rangeControl } from './controls.ts';

function info(id: string, name: string, polyphony: number, description: string, era = '1977–1985'): InstrumentInfo {
	return { id, name, polyphony, description, era, family: id.startsWith('sid') ? 'sid' : 'console' };
}

export const registerInstruments: readonly InstrumentDef[] = [
	...(['sn76489', 'tandy'] as const).map((id): InstrumentDef => {
		const description = info(
			id,
			id === 'tandy' ? 'Tandy SN76489' : 'SN76489',
			3,
			'Trois canaux carrés du SN76489, avec enveloppe logicielle et vibrato.',
		);
		return {
			info: description,
			create(options) {
				const chip = new Sn76489({ ...options, variant: id === 'tandy' ? 'ti' : 'sega' });
				const pitch = (channel: number, hz: number): void => {
					const period = Math.max(1, Math.min(1023, Math.round(chip.clock / (32 * hz))));
					chip.write(0, 0x80 | (channel << 5) | (period & 15));
					chip.write(0, period >> 4);
				};
				return new RegisterInstrument(
					description,
					chip,
					{
						pitch,
						start: (channel, hz) => pitch(channel, hz),
						level: (channel, level) =>
							chip.write(
								0,
								0x90 |
									(channel << 5) |
									(level <= 0.001
										? 15
										: Math.max(0, Math.min(15, Math.round(-10 * Math.log10(level))))),
							),
						stop: (channel) => chip.write(0, 0x9f | (channel << 5)),
					},
					options,
				);
			},
		};
	}),
	...(['mos6581', 'mos8580'] as const).map((model): InstrumentDef => {
		const description = info(
			model === 'mos6581' ? 'sid' : 'sid-8580',
			`MOS ${model === 'mos6581' ? '6581' : '8580'} SID`,
			3,
			'Trois oscillateurs SID, onde et largeur d’impulsion, enveloppe matérielle ADSR.',
		);
		return {
			info: description,
			create(options) {
				const chip = new Sid({ ...options, model });
				const wave = param(1),
					width = param(2048),
					attack = param(0),
					decay = param(5),
					sustain = param(12),
					release = param(5);
				const pitch = (channel: number, hz: number): void => {
					const frequency = Math.max(0, Math.min(65535, Math.round((hz * 16777216) / chip.clock)));
					chip.write(channel * 7, frequency & 255);
					chip.write(channel * 7 + 1, frequency >> 8);
				};
				const controls = [
					choiceControl(
						{ id: 'wave', label: 'Oscillateur : onde' },
						labelled(['Triangle', 'Dent de scie', 'Impulsion', 'Bruit']),
						wave,
					),
				];
				const ranges = [
					rangeControl({ id: 'width', label: 'Largeur d’impulsion', min: 1, max: 4095, step: 1 }, width),
					...[
						['attack', attack],
						['decay', decay],
						['sustain', sustain],
						['release', release],
					].map(([id, value]) =>
						rangeControl(
							{ id: String(id), label: `ADSR : ${id}`, min: 0, max: 15, step: 1 },
							value as typeof attack,
						),
					),
				];
				return new RegisterInstrument(
					description,
					chip,
					{
						controls: [...controls, ...ranges],
						restore: () => chip.write(24, 0),
						pitch,
						start(channel, hz, velocity) {
							chip.write(24, 15);
							pitch(channel, hz);
							const base = channel * 7;
							chip.write(base + 2, width.value & 255);
							chip.write(base + 3, width.value >> 8);
							chip.write(base + 5, (attack.value << 4) | decay.value);
							chip.write(base + 6, (Math.round((sustain.value * velocity) / 127) << 4) | release.value);
							chip.write(base + 4, ((1 << wave.value) << 4) | 1);
						},
						stop(channel) {
							const address = channel * 7 + 4;
							chip.write(address, chip.read(address) & ~1);
						},
					},
					options,
				);
			},
		};
	}),
	...(['ntsc', 'pal'] as const).map((standard): InstrumentDef => {
		const description = info(
			standard === 'ntsc' ? 'nes-apu' : 'nes-apu-pal',
			`NES APU ${standard.toUpperCase()}`,
			2,
			'Deux canaux pulse de l’APU, duty et enveloppe logicielle ; horloge PAL/NTSC conservée.',
		);
		return {
			info: description,
			create(options) {
				const chip = new NesApu({ ...options, standard });
				const duty = param(2);
				const pitch = (channel: number, hz: number): void => {
					const period = Math.max(8, Math.min(2047, Math.round(chip.clock / (16 * hz) - 1)));
					chip.write(0x4002 + 4 * channel, period & 255);
					chip.write(0x4003 + 4 * channel, period >> 8);
				};
				return new RegisterInstrument(
					description,
					chip,
					{
						controls: [
							choiceControl(
								{ id: 'duty', label: 'Duty pulse' },
								labelled(['12,5 %', '25 %', '50 %', '75 %']),
								duty,
							),
						],
						restore: () => chip.write(0x4015, 3),
						pitch,
						start: (channel, hz) => pitch(channel, hz),
						level: (channel, level) =>
							chip.write(0x4000 + channel * 4, (duty.value << 6) | 0x30 | Math.round(level * 15)),
						stop: (channel) => chip.write(0x4000 + channel * 4, 0x30),
					},
					options,
				);
			},
		};
	}),
	{
		info: info('vrc6', 'Konami VRC6', 3, 'Deux pulse et une dent de scie du VRC6 (Akumajou Densetsu).', '1988'),
		create(options) {
			const chip = new Vrc6(options);
			const duty = param(3);
			const base = (channel: number): number => (channel === 2 ? 0xb000 : channel === 1 ? 0xa000 : 0x9000);
			const pitch = (channel: number, hz: number): void => {
				const period = Math.max(
					0,
					Math.min(511, Math.round(chip.clock / ((channel === 2 ? 28 : 16) * hz)) - 1),
				);
				chip.write(base(channel) | 1, period & 255);
				chip.write(base(channel) | 2, 0x80 | (period >> 8));
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					controls: [
						choiceControl(
							{
								id: 'duty',
								label: 'Rapport des pulse',
								hint: 'Largeur d’impulsion des deux canaux à pulse',
							},
							labelled(['1/16', '2/16', '3/16', '4/16', '5/16', '6/16', '7/16', '8/16']),
							duty,
						),
					],
					restore: () => chip.write(0x9003, 0),
					pitch,
					start: (channel, hz) => pitch(channel, hz),
					level: (channel, level) =>
						channel === 2
							? chip.write(0xb000, Math.round(Math.max(0, Math.min(63, level * 63))))
							: chip.write(
									base(channel),
									0x80 | (duty.value << 4) | Math.round(Math.max(0, Math.min(15, level * 15))),
								),
					stop: (channel) => {
						chip.write(channel === 2 ? 0xb000 : base(channel), 0);
						chip.write(base(channel) | 2, 0);
					},
				},
				options,
			);
		},
	},
	{
		info: info('mmc5', 'Nintendo MMC5', 2, 'Deux pulse du MMC5, sans balayage de fréquence.', '1987'),
		create(options) {
			const chip = new Mmc5(options);
			const duty = param(2);
			const pitch = (channel: number, hz: number): void => {
				const period = Math.max(8, Math.min(2047, Math.round(chip.clock / (16 * hz) - 1)));
				chip.write(0x1002 + 4 * channel, period & 255);
				chip.write(0x1003 + 4 * channel, period >> 8);
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					controls: [
						choiceControl(
							{ id: 'duty', label: 'Duty pulse' },
							labelled(['12,5 %', '25 %', '50 %', '75 %']),
							duty,
						),
					],
					restore: () => chip.write(0x1015, 3),
					pitch,
					start: (channel, hz) => pitch(channel, hz),
					level: (channel, level) =>
						chip.write(0x1000 + 4 * channel, (duty.value << 6) | 0x30 | Math.round(level * 15)),
					stop: (channel) => chip.write(0x1000 + 4 * channel, 0x30),
				},
				options,
			);
		},
	},
	{
		info: info(
			'sunsoft5b',
			'Sunsoft 5B',
			3,
			'Le PSG de la cartouche Gimmick! : trois pulse, enveloppe logicielle, sans bruit.',
			'1990',
		),
		create(options) {
			const chip = new Sunsoft5b(options);
			const write = (register: number, value: number): void => {
				chip.write(0xc000, register);
				chip.write(0xe000, value);
			};
			const pitch = (channel: number, hz: number): void => {
				const period = Math.max(1, Math.min(4095, Math.round(chip.clock / (32 * hz))));
				write(2 * channel, period & 255);
				write(2 * channel + 1, period >> 8);
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					pitch,
					start: (channel, hz) => pitch(channel, hz),
					level: (channel, level) =>
						write(
							8 + channel,
							level <= 0.002 ? 0 : Math.max(0, Math.min(15, Math.round(15 + 2 * Math.log2(level)))),
						),
					stop: (channel) => write(8 + channel, 0),
					restore: () => write(7, 0x38),
				},
				options,
			);
		},
	},
	{
		info: info(
			'namco163',
			'Namco 163',
			4,
			'Trois canaux à table d’onde 4 bits du 163, table partagée, balayage logique à quatre canaux.',
			'1985',
		),
		create(options) {
			const chip = new Namco163(options);
			const shape = param(0);
			const write = (index: number, value: number): void => {
				chip.write(0xf800, index | 0x80);
				chip.write(0x4800, value);
			};
			const loadWaves = (): void => {
				const sample = (position: number): number => {
					const phase = (position % 32) / 32;
					if (shape.value === 1) return Math.round(phase * 15);
					if (shape.value === 2) return phase < 0.5 ? 15 : 0;
					return Math.round(7.5 * (1 + Math.sin(2 * Math.PI * phase)));
				};
				for (let wave = 0; wave < 4; wave++)
					for (let i = 0; i < 32; i += 2) write(wave * 16 + (i >> 1), sample(i) | (sample(i + 1) << 4));
			};
			const base = (channel: number): number => 0x60 + 8 * channel;
			const pitch = (channel: number, hz: number): void => {
				const frequency = Math.max(0, Math.min(262143, Math.round((hz * 32 * 65536 * 60) / chip.clock)));
				write(base(channel), frequency & 255);
				write(base(channel) + 2, (frequency >> 8) & 255);
				write(base(channel) + 4, 224 | ((frequency >> 16) & 3));
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					controls: [
						choiceControl(
							{ id: 'wave', label: 'Table d’onde' },
							labelled(['Sinus', 'Dent de scie', 'Carré']),
							shape,
							() => loadWaves(),
						),
					],
					pitch,
					start: (channel, hz) => pitch(channel, hz),
					level: (channel, level) => {
						const volume = Math.max(0, Math.min(15, Math.round(level * 15)));
						if (channel === 3) write(0x7f, 0x30 | volume);
						else write(base(channel) + 7, volume);
					},
					stop: (channel) => (channel === 3 ? write(0x7f, 0x30) : write(base(channel) + 7, 0)),
					restore() {
						loadWaves();
						for (let channel = 0; channel < 4; channel++)
							for (let offset = 0; offset < 8; offset++)
								write(base(channel) + offset, offset === 4 ? 224 : offset === 6 ? channel * 32 : 0);
						write(0x7f, 0x30);
					},
				},
				options,
			);
		},
	},
	{
		info: info(
			'fds',
			'Famicom Disk System',
			1,
			'Le canal wavetable 64 × 6 bits du Disque System ; la table se recharge depuis le panneau.',
			'1986',
		),
		create(options) {
			const chip = new Fds(options);
			const shape = param(0),
				master = param(3);
			const loadWave = (): void => {
				chip.write(0x4089, 0x80 | master.value);
				for (let i = 0; i < 64; i++) {
					const phase = i / 64;
					const value =
						shape.value === 1
							? Math.round(63 * phase)
							: shape.value === 2
								? phase < 0.5
									? 63
									: 0
								: Math.round(31.5 * (1 + Math.sin(2 * Math.PI * phase)));
					chip.write(0x4040 + i, value);
				}
				chip.write(0x4089, master.value);
			};
			const pitch = (_channel: number, hz: number): void => {
				const frequency = Math.max(0, Math.min(65535, Math.round((hz * 2 ** 22) / chip.clock)));
				chip.write(0x4082, frequency & 255);
				chip.write(0x4083, ((frequency >> 8) & 15) | 0x40);
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					controls: [
						choiceControl(
							{ id: 'wave', label: 'Table d’onde' },
							labelled(['Sinus', 'Dent de scie', 'Carré']),
							shape,
							() => loadWave(),
						),
						choiceControl(
							{ id: 'master', label: 'Volume maître' },
							labelled(['Faible', 'Moyen', 'Élevé', 'Maximum']),
							master,
							() => chip.write(0x4089, master.value),
						),
					],
					pitch,
					start: (channel, hz) => pitch(channel, hz),
					level: (_channel, level) =>
						chip.write(0x4080, 0x80 | Math.max(0, Math.min(32, Math.round(level * 32)))),
					stop: () => chip.write(0x4080, 0x80),
					restore() {
						chip.write(0x4084, 0x80);
						chip.write(0x4087, 0x80);
						chip.write(0x4080, 0x80);
						loadWave();
					},
				},
				options,
			);
		},
	},
];

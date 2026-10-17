import type { Chip } from '../chips/Chip.ts';
import { Saa1099 } from '../chips/Saa1099.ts';
import { CmsCard } from '../chips/cards.ts';
import { PcSpeaker } from '../chips/PcSpeaker.ts';
import { AppleSpeaker, Mockingboard } from '../chips/AppleII.ts';
import { PcmDac } from '../chips/PcmDac.ts';
import { RegisterInstrument } from './RegisterInstrument.ts';
import { VoiceInstrument } from './VoiceInstrument.ts';
import { VoiceAllocator } from './VoiceAllocator.ts';
import { BaseInstrument } from './BaseInstrument.ts';
import { choiceControl, labelled, param, rangeControl } from './controls.ts';
import type { InstrumentDef, InstrumentInfo, InstrumentOptions } from './Instrument.ts';

const appleInfo: InstrumentInfo = {
	id: 'apple2-speaker',
	name: 'Apple II (bascule $C030)',
	family: 'speaker',
	era: '1977',
	polyphony: 1,
	pitchTolerance: 40,
	description:
		'Le haut-parleur un bit de l’Apple II : la hauteur vient du rythme des bascules de $C030, placées au cycle près ; la vélocité n’a pas de prise sur un bit.',
};

class AppleSpeakerInstrument extends VoiceInstrument {
	readonly info = appleInfo;
	readonly chip: AppleSpeaker = new AppleSpeaker({ sampleRate: this.sampleRate });
	protected readonly allocator = new VoiceAllocator(1);
	private half = 96;
	private phase = 0;
	constructor(options: InstrumentOptions = {}) {
		super(options);
		this.softEnvelope = false;
		this.controls = this.vibratoControls();
		this.restore();
	}
	protected startVoice(_channel: number, hz: number): void {
		this.chip.setMuted(0, false);
		this.phase = 0;
		this.setVoicePitch(0, hz);
	}
	protected setVoicePitch(_channel: number, hz: number): void {
		this.half = Math.max(1, this.sampleRate / (2 * hz));
	}
	protected stopVoice(): void {
		this.chip.setMuted(0, true);
	}
	protected override restore(): void {
		this.chip.setMuted(0, true);
	}
	override render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		if (this.allocator.active().length > 0) {
			while (this.phase < count) {
				this.chip.writeAt(this.phase, 0xc030, 0);
				this.phase += this.half;
			}
			this.phase -= count;
		}
		super.render(left, right, start, count);
	}
}

const dacInfo: InstrumentInfo = {
	id: 'pcm-dac',
	name: 'Sample DAC (Covox)',
	family: 'sampler',
	era: '1985',
	polyphony: 1,
	pitched: false,
	description:
		'Convertisseur stéréo 8 bits sans hauteur musicale : une note impose la tension de sortie selon sa vélocité, le relâchement revient au centre du convertisseur.',
};

class SampleDacInstrument extends BaseInstrument {
	readonly info = dacInfo;
	readonly chip: PcmDac = new PcmDac({ sampleRate: this.sampleRate, stereo: true });
	private readonly maximum = param(100);
	private readonly pan = param(0);
	private sounding = -1;
	constructor(options: InstrumentOptions = {}) {
		super(options);
		this.controls = [
			rangeControl({ id: 'level', label: 'Niveau maximal', min: 0, max: 127, step: 1 }, this.maximum),
			rangeControl({ id: 'pan', label: 'Panoramique', min: -1, max: 1, step: 0.01 }, this.pan),
		];
	}
	protected override restore(): void {
		this.sounding = -1;
	}
	protected press(note: number, velocity: number): void {
		const amplitude = (this.maximum.value / 127) * (0.25 + 0.75 * (velocity / 127) ** 1.5);
		this.chip.write(0, 128 + Math.round(127 * amplitude * Math.min(1, 1 - this.pan.value)));
		this.chip.write(1, 128 + Math.round(127 * amplitude * Math.min(1, 1 + this.pan.value)));
		this.sounding = note;
	}
	protected lift(note: number): void {
		if (this.sounding !== note) return;
		this.chip.write(0, 128);
		this.chip.write(1, 128);
		this.sounding = -1;
	}
}

export const pcInstruments: readonly InstrumentDef[] = [
	...['saa1099', 'cms'].map((id): InstrumentDef => {
		const info: InstrumentInfo = {
			id,
			name: id === 'cms' ? 'C/MS Game Blaster' : 'Philips SAA1099',
			family: id === 'cms' ? 'card' : 'psg',
			era: '1984–1987',
			polyphony: id === 'cms' ? 12 : 6,
			description: 'Canaux carrés SAA1099 avec panoramique stéréo, enveloppe logicielle et vibrato.',
		};
		return {
			info,
			create(options) {
				const chip: Chip = id === 'cms' ? new CmsCard(options) : new Saa1099(options);
				const write = (unit: number, register: number, value: number): void => {
					if (id === 'cms') {
						chip.write(0x221 + unit * 2, register);
						chip.write(0x220 + unit * 2, value);
					} else chip.write(register, value);
				};
				const octaves = [new Uint8Array(3), new Uint8Array(3)];
				const pan = param(0);
				const pitch = (channel: number, hz: number): void => {
					const unit = Math.floor(channel / 6),
						voice = channel % 6;
					let octave = 0,
						frequency = 511 - chip.clock / 512 / hz;
					while (frequency > 255 && octave < 7) {
						octave++;
						frequency = 511 - ((chip.clock / 512) * 2 ** octave) / hz;
					}
					write(unit, 8 + voice, Math.max(0, Math.min(255, Math.round(frequency))));
					const pair = voice >> 1,
						shift = (voice & 1) * 4;
					octaves[unit][pair] = (octaves[unit][pair] & ~(7 << shift)) | (octave << shift);
					write(unit, 0x10 + pair, octaves[unit][pair]);
				};
				return new RegisterInstrument(
					info,
					chip,
					{
						controls: [rangeControl({ id: 'pan', label: 'Panoramique', min: -1, max: 1, step: 0.01 }, pan)],
						restore() {
							for (let unit = 0; unit < info.polyphony / 6; unit++) {
								octaves[unit].fill(0);
								write(unit, 0x1c, 1);
								write(unit, 0x14, 63);
							}
						},
						pitch,
						start: (channel, hz) => pitch(channel, hz),
						level(channel, level) {
							const left = Math.round(15 * level * Math.min(1, 1 - pan.value));
							const right = Math.round(15 * level * Math.min(1, 1 + pan.value));
							write(Math.floor(channel / 6), channel % 6, left | (right << 4));
						},
						stop: (channel) => write(Math.floor(channel / 6), channel % 6, 0),
					},
					options,
				);
			},
		};
	}),
	{
		info: {
			id: 'pc-speaker',
			name: 'PC speaker',
			family: 'speaker',
			era: '1981',
			polyphony: 1,
			description:
				'Haut-parleur un bit commandé par le PIT. Le volume et la vélocité ne modifient pas l’amplitude native de ce circuit.',
		},
		create(options) {
			const chip = new PcSpeaker(options),
				mode = param(0);
			const pitch = (_channel: number, hz: number): void => {
				const divisor = Math.max(1, Math.min(65535, Math.round(chip.clock / hz)));
				chip.write(0x43, mode.value === 0 ? 0xb6 : 0xb4);
				chip.write(0x42, divisor & 255);
				chip.write(0x42, divisor >> 8);
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					controls: [
						choiceControl(
							{ id: 'mode', label: 'PIT : mode' },
							labelled(['Carré (mode 3)', 'Impulsions (mode 2)']),
							mode,
						),
					],
					// the idle speaker sits on the negative rail (RealSound idles there too): the instrument parks it at zero instead
					pitch,
					start(channel, hz) {
						chip.setMuted(0, false);
						pitch(channel, hz);
						chip.write(0x61, 3);
					},
					stop: () => {
						chip.write(0x61, 0);
						chip.setMuted(0, true);
					},
					restore: () => chip.setMuted(0, true),
				},
				options,
			);
		},
	},
	{
		info: {
			id: 'mockingboard',
			name: 'Mockingboard',
			family: 'card',
			era: '1983',
			polyphony: 6,
			description:
				'Les deux AY-3-8910 de la carte Mockingboard : trois canaux à gauche, trois à droite ; enveloppe logicielle et vibrato.',
		},
		create(options) {
			const chip = new Mockingboard(options);
			const write = (register: number, value: number, unit: number): void => {
				chip.write(0x100 | (unit << 4) | register, value);
			};
			const pitch = (channel: number, hz: number): void => {
				const unit = channel >= 3 ? 1 : 0,
					voice = channel % 3,
					period = Math.max(1, Math.min(4095, Math.round(chip.clock / (16 * hz))));
				write(2 * voice, period & 255, unit);
				write(2 * voice + 1, period >> 8, unit);
			};
			return new RegisterInstrument(
				this.info,
				chip,
				{
					pitch,
					start: (channel, hz) => pitch(channel, hz),
					level: (channel, level) =>
						write(
							8 + (channel % 3),
							level <= 0.002 ? 0 : Math.max(0, Math.min(15, Math.round(15 + 2 * Math.log2(level)))),
							channel >= 3 ? 1 : 0,
						),
					stop: (channel) => write(8 + (channel % 3), 0, channel >= 3 ? 1 : 0),
					restore() {
						for (const unit of [0, 1]) {
							write(7, 0x38, unit);
							for (let voice = 0; voice < 3; voice++) write(8 + voice, 0, unit);
						}
					},
				},
				options,
			);
		},
	},
	{ info: appleInfo, create: (options) => new AppleSpeakerInstrument(options) },
	{ info: dacInfo, create: (options) => new SampleDacInstrument(options) },
];

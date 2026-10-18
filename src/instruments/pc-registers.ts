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
import type { ChoiceOption, InstrumentDef, InstrumentInfo, InstrumentOptions } from './Instrument.ts';

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
	polyphony: 4,
	description:
		'Convertisseur stéréo 8 bits tenu sur la dernière valeur écrite (Covox Speech Thing, Sound Blaster en sortie directe). Il n’a pas de voix propre : un lecteur logiciel calcule la forme d’onde de chaque note, mélange les voix et écrit une valeur 8 bits au rythme choisi, comme le faisaient les lecteurs de modules sur ce matériel.',
};

const DAC_WAVES: readonly ChoiceOption[] = [
	{ value: 0, label: 'Triangle' },
	{ value: 1, label: 'Sinus' },
	{ value: 2, label: 'Dent de scie' },
	{ value: 3, label: 'Carré' },
];
const DAC_RATES: readonly ChoiceOption[] = [8000, 11025, 16000, 22050, 32000, 44100].map((hz) => ({
	value: hz,
	label: `${hz} Hz`,
}));

interface DacVoice {
	note: number;
	phase: number;
	gain: number;
	/** 0 while the note is held, then the release factor applied each written sample */
	level: number;
	releasing: boolean;
}

/** one cycle of the waveform at `phase` in 0..1, in -1..1 */
function dacWave(kind: number, phase: number): number {
	if (kind === 1) return Math.sin(2 * Math.PI * phase);
	if (kind === 2) return 2 * phase - 1;
	if (kind === 3) return phase < 0.5 ? 1 : -1;
	return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
}

class SampleDacInstrument extends BaseInstrument {
	readonly info = dacInfo;
	readonly chip: PcmDac = new PcmDac({ sampleRate: this.sampleRate, stereo: true });
	private readonly maximum = param(100);
	private readonly pan = param(0);
	private readonly wave = param(0);
	private readonly rate = param(22050);
	private readonly release = param(0.25);
	private readonly voices: DacVoice[] = [];
	/** position inside the current held sample, in output samples */
	private hold = 1;
	constructor(options: InstrumentOptions = {}) {
		super(options);
		this.controls = [
			rangeControl({ id: 'level', label: 'Niveau maximal', min: 0, max: 127, step: 1 }, this.maximum),
			rangeControl({ id: 'pan', label: 'Panoramique', min: -1, max: 1, step: 0.01 }, this.pan),
			choiceControl({ id: 'wave', label: 'Forme d’onde calculée', group: 'Lecteur' }, DAC_WAVES, this.wave),
			choiceControl({ id: 'rate', label: 'Cadence d’écriture', group: 'Lecteur' }, DAC_RATES, this.rate),
			rangeControl(
				{ id: 'release', label: 'Relâchement', group: 'Lecteur', min: 0.02, max: 2, step: 0.01, unit: 's' },
				this.release,
			),
		];
	}
	protected override restore(): void {
		this.voices.length = 0;
		this.hold = 1;
		this.chip.write(0, 128);
		this.chip.write(1, 128);
	}
	protected press(note: number, velocity: number): void {
		const gain = (this.maximum.value / 127) * (0.25 + 0.75 * (velocity / 127) ** 1.5) * 0.45;
		const voice: DacVoice = { note, phase: 0, gain, level: 1, releasing: false };
		const free = this.voices.findIndex((v) => v.level <= 0);
		if (free >= 0) this.voices[free] = voice;
		else if (this.voices.length < this.info.polyphony) this.voices.push(voice);
		else {
			const oldest = this.voices.findIndex((v) => v.releasing);
			this.voices[oldest >= 0 ? oldest : 0] = voice;
		}
	}
	protected lift(note: number): void {
		for (const voice of this.voices) if (voice.note === note && !voice.releasing) voice.releasing = true;
	}
	override render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const step = this.rate.value / this.sampleRate;
		const fall = 1 / (this.release.value * this.rate.value);
		const pan = this.pan.value;
		for (let i = 0; i < count; i++) {
			this.hold += step;
			if (this.hold >= 1) {
				this.hold -= 1;
				let mix = 0;
				for (const voice of this.voices) {
					if (voice.level <= 0) continue;
					mix += dacWave(this.wave.value, voice.phase) * voice.gain * voice.level;
					voice.phase += this.hz(voice.note) / this.rate.value;
					voice.phase -= Math.floor(voice.phase);
					if (voice.releasing) voice.level = Math.max(0, voice.level - fall);
				}
				mix = Math.max(-1, Math.min(1, mix));
				this.chip.write(0, 128 + Math.round(127 * mix * Math.min(1, 1 - pan)));
				this.chip.write(1, 128 + Math.round(127 * mix * Math.min(1, 1 + pan)));
			}
			this.chip.render(left, right, start + i, 1);
		}
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

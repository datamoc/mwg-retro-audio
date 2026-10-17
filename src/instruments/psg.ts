import { Ym2149 } from '../chips/Ym2149.ts';
import type { Chip } from '../chips/Chip.ts';
import { choiceControl, labelled, param, rangeControl, toggleControl } from './controls.ts';
import type { InstrumentDef, InstrumentInfo, InstrumentOptions } from './Instrument.ts';
import { VoiceAllocator } from './VoiceAllocator.ts';
import { VoiceInstrument } from './VoiceInstrument.ts';

/**
 * Yamaha YM2149 and General Instrument AY-3-8910: three square wave channels, one noise generator, a mixer and one
 * hardware envelope shared by the channels. This file is the pattern the other register chip instruments follow.
 *
 * Three ways to shape a note, as on the real chips:
 *  - software envelope (default): the volume register is updated a few hundred times a second, the way a tracker does;
 *  - hardware envelope: the chip's own envelope generator (shape and period) drives the volume of the note;
 *  - buzzer: the hardware envelope runs at the pitch of the note and becomes the oscillator (the "buzz bass" of the
 *    Atari ST and ZX Spectrum), with the tone generator switched off.
 */

const ENVELOPE_SHAPES = [
	{ value: 9, label: '\\___  decay (one shot)' },
	{ value: 15, label: '/___  attack then off' },
	{ value: 13, label: '/¯¯¯  attack and hold' },
	{ value: 11, label: '\\¯¯¯  decay then full' },
	{ value: 8, label: '\\\\\\\\  saw down (repeat)' },
	{ value: 12, label: '////  saw up (repeat)' },
	{ value: 10, label: '\\/\\/  triangle (repeat)' },
	{ value: 14, label: '/\\/\\  triangle, up first (repeat)' },
];

const BUZZER_SHAPES = [
	{ value: 8, label: 'Saw down' },
	{ value: 12, label: 'Saw up' },
	{ value: 10, label: 'Triangle' },
	{ value: 14, label: 'Triangle (up first)' },
];

const MODES = ['Software envelope', 'Hardware envelope', 'Buzzer (envelope is the oscillator)'];

class Ym2149Instrument extends VoiceInstrument {
	readonly info: InstrumentInfo;
	readonly chip: Ym2149;
	protected readonly allocator = new VoiceAllocator(3);
	private readonly p = {
		tone: param(true),
		noise: param(false),
		noisePeriod: param(8),
		mode: param(0),
		hwShape: param(9),
		hwPeriod: param(3000),
		buzzShape: param(8),
		buzzOctave: param(0),
		maxVolume: param(15),
	};
	private readonly buzzing = [false, false, false];
	private readonly lastVolume = [-1, -1, -1];

	constructor(def: InstrumentInfo, model: 'ym2149' | 'ay8910', options: InstrumentOptions = {}) {
		super(options);
		this.info = def;
		this.chip = new Ym2149({ sampleRate: this.sampleRate, model });
		const p = this.p;
		this.softEnvelope = true;
		this.controls = [
			choiceControl(
				{ id: 'mode', label: 'Envelope', group: 'Sound', hint: 'Who shapes the volume of a note' },
				labelled(MODES),
				p.mode,
				() => {
					this.softEnvelope = p.mode.value === 0;
					this.changed();
				},
			),
			toggleControl(
				{ id: 'tone', label: 'Tone', group: 'Mixer', hint: 'Square wave generator of the channel' },
				p.tone,
				() => this.mixer(),
			),
			toggleControl(
				{ id: 'noise', label: 'Noise', group: 'Mixer', hint: 'Mix the noise generator into the notes' },
				p.noise,
				() => this.mixer(),
			),
			rangeControl(
				{
					id: 'noise-period',
					label: 'Noise period',
					group: 'Mixer',
					min: 0,
					max: 31,
					step: 1,
					hint: 'Register 6: a higher value is a lower, softer noise',
				},
				p.noisePeriod,
				(v) => this.chip.write(6, v),
			),
			rangeControl(
				{
					id: 'max-volume',
					label: 'Volume',
					group: 'Mixer',
					min: 1,
					max: 15,
					step: 1,
					hint: 'Loudest volume step the software envelope uses (3 dB per step)',
				},
				p.maxVolume,
			),
			choiceControl(
				{ id: 'hw-shape', label: 'Shape', group: 'Hardware envelope', hint: 'Register 13' },
				ENVELOPE_SHAPES,
				p.hwShape,
				() => this.refreshEnvelope(),
			),
			rangeControl(
				{
					id: 'hw-period',
					label: 'Period',
					group: 'Hardware envelope',
					min: 1,
					max: 65535,
					step: 1,
					scale: 'log',
					hint: 'Registers 11-12: the envelope runs at clock / (256 x period)',
				},
				p.hwPeriod,
				() => this.refreshEnvelope(),
			),
			choiceControl(
				{
					id: 'buzz-shape',
					label: 'Shape',
					group: 'Buzzer',
					hint: 'Waveform of the envelope used as the oscillator',
				},
				BUZZER_SHAPES,
				p.buzzShape,
			),
			rangeControl(
				{
					id: 'buzz-octave',
					label: 'Octave',
					group: 'Buzzer',
					min: -2,
					max: 2,
					step: 1,
					hint: 'Shift of the buzzer against the note',
				},
				p.buzzOctave,
			),
			...this.ampControls('Software envelope'),
			...this.vibratoControls(),
		];
		this.presets = [
			this.preset('Square lead', { 'amp-decay': 400, 'amp-sustain': 0.7 }),
			this.preset('Pluck', { 'amp-decay': 180, 'amp-sustain': 0, 'amp-release': 40 }),
			this.preset('Noisy lead', { noise: true, 'noise-period': 4, 'amp-decay': 200, 'amp-sustain': 0.5 }),
			this.preset('Pad with vibrato', {
				'amp-attack': 300,
				'amp-sustain': 1,
				'amp-release': 500,
				'vib-depth': 25,
				'vib-rate': 5,
			}),
			this.preset('Buzz bass', { mode: 2, tone: false, 'buzz-shape': 8, 'buzz-octave': -1 }),
			this.preset('Triangle buzz', { mode: 2, tone: false, 'buzz-shape': 10, 'buzz-octave': 0 }),
			this.preset('Hardware decay', { mode: 1, 'hw-shape': 9, 'hw-period': 2500 }),
			this.preset('Tremolo envelope', { mode: 1, 'hw-shape': 10, 'hw-period': 40 }),
		];
		this.restore();
	}

	protected override restore(): void {
		this.softEnvelope = this.p.mode.value === 0;
		this.chip.write(6, this.p.noisePeriod.value);
		this.lastVolume.fill(-1);
		this.mixer();
	}

	private mixer(): void {
		let value = 0;
		for (let ch = 0; ch < 3; ch++) {
			if (!this.p.tone.value || this.buzzing[ch]) value |= 1 << ch;
			if (!this.p.noise.value) value |= 8 << ch;
		}
		this.chip.write(7, value);
	}

	private refreshEnvelope(): void {
		if (this.p.mode.value !== 1) return;
		const period = this.p.hwPeriod.value;
		this.chip.write(11, period & 255);
		this.chip.write(12, period >> 8);
		this.chip.write(13, this.p.hwShape.value);
	}

	private writeVolume(ch: number, register: number): void {
		if (this.lastVolume[ch] === register) return;
		this.lastVolume[ch] = register;
		this.chip.write(8 + ch, register);
	}

	private period(hz: number): number {
		return Math.max(1, Math.min(4095, Math.round(this.chip.clock / (16 * hz))));
	}

	protected startVoice(channel: number, hz: number): void {
		this.buzzing[channel] = this.p.mode.value === 2;
		this.mixer();
		this.setVoicePitch(channel, hz);
		if (this.p.mode.value === 1) {
			this.writeVolume(channel, 0x10);
			this.refreshEnvelope();
		} else if (this.p.mode.value === 2) {
			this.writeVolume(channel, 0x10);
			this.chip.write(13, this.p.buzzShape.value);
		}
	}

	protected setVoicePitch(channel: number, hz: number): void {
		const period = this.period(hz);
		this.chip.write(channel * 2, period & 255);
		this.chip.write(channel * 2 + 1, period >> 8);
		if (this.p.mode.value === 2) {
			// the envelope is the oscillator: a cycle is 16 steps of clock / (256 x period) for a saw, twice that for a triangle
			const triangle = this.p.buzzShape.value === 10 || this.p.buzzShape.value === 14;
			const f = hz * 2 ** this.p.buzzOctave.value;
			const e = Math.max(1, Math.min(65535, Math.round(this.chip.clock / ((triangle ? 512 : 256) * f))));
			this.chip.write(11, e & 255);
			this.chip.write(12, e >> 8);
		}
	}

	protected stopVoice(channel: number): void {
		this.writeVolume(channel, 0);
		this.buzzing[channel] = false;
		this.mixer();
	}

	protected override setVoiceLevel(channel: number, level: number): void {
		if (this.p.mode.value !== 0) return;
		// the volume DAC is logarithmic, 3 dB a step: a linear envelope level maps to 2 steps per octave of amplitude
		const step = level <= 0.002 ? 0 : Math.round(this.p.maxVolume.value + 2 * Math.log2(Math.min(1, level)));
		this.writeVolume(channel, Math.max(0, Math.min(15, step)));
	}
}

const ymInfo: InstrumentInfo = {
	id: 'ym2149',
	name: 'Yamaha YM2149',
	family: 'psg',
	era: '1983-1995',
	description:
		'Three square wave channels, a noise generator and a hardware envelope (Atari ST, Amstrad CPC, MSX, ZX Spectrum 128). Mix tone and noise, pick the envelope mode, or turn the envelope into a buzzing oscillator.',
	polyphony: 3,
	pitchTolerance: 40,
};

const ayInfo: InstrumentInfo = {
	...ymInfo,
	id: 'ay8910',
	name: 'General Instrument AY-3-8910',
	era: '1978-1990',
	description:
		'The original three channel PSG with 16 envelope steps (Intellivision, Vectrex, ZX Spectrum 128, MSX). Same controls as the YM2149, a coarser volume and envelope.',
};

export const psgInstruments: InstrumentDef[] = [
	{ info: ymInfo, create: (o) => new Ym2149Instrument(ymInfo, 'ym2149', o) },
	{ info: ayInfo, create: (o) => new Ym2149Instrument(ayInfo, 'ay8910', o) },
];

export type { Chip };

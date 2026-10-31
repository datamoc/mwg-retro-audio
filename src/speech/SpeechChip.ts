import type { Chip, ChipOptions } from '../chips/Chip.ts';
import { glottalPulse, Resonator, type SourceShape } from './FormantSynth.ts';

/** Register map of the speech chip (every register is 8 bit; 16 bit values are low byte first) */
export const SPEECH_REGISTERS = {
	/** 0-1: fundamental frequency in 1/16 Hz (0 = unvoiced) */
	F0: 0,
	/** 2-3, 4-5, 6-7: formant frequencies F1, F2, F3 in Hz */
	F1: 2,
	F2: 4,
	F3: 6,
	/** 8, 9, 10: bandwidths B1, B2, B3 in units of 4 Hz */
	B1: 8,
	B2: 9,
	B3: 10,
	/** 11: voicing amplitude 0..255, 12: noise amplitude 0..255 */
	VOICE: 11,
	NOISE: 12,
	/** 13: bit 0 selects the sawtooth (vocoder) source instead of the glottal pulse */
	CONTROL: 13,
} as const;

const UPDATE_INTERVAL = 16;

/**
 * A formant speech synthesizer driven like a chip: a player writes pitch, formants and amplitudes in time order and
 * asks for the audio that follows, so speech and singing can be sequenced next to the other chips.
 */
export class SpeechChip implements Chip {
	readonly id = 'formant-speech';
	readonly name = 'Formant speech synthesizer';
	readonly channels = 1;
	readonly clock = 1_000_000;
	readonly sampleRate: number;
	private readonly registers = new Uint8Array(16);
	private readonly resonators = [new Resonator(), new Resonator(), new Resonator()];
	private readonly upper = [new Resonator(), new Resonator()];
	private phase = 0;
	private noiseState = 0x1234567;
	private muted = false;
	private sinceUpdate = UPDATE_INTERVAL;

	constructor(options: ChipOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.upper[0].set(3300, 250, this.sampleRate);
		this.upper[1].set(3750, 200, this.sampleRate);
		this.reset();
	}

	reset(): void {
		this.registers.fill(0);
		const r = SPEECH_REGISTERS;
		this.write16(r.F1, 500);
		this.write16(r.F2, 1500);
		this.write16(r.F3, 2500);
		this.registers[r.B1] = 15;
		this.registers[r.B2] = 22;
		this.registers[r.B3] = 37;
		this.phase = 0;
		this.sinceUpdate = UPDATE_INTERVAL;
	}

	write(addr: number, value: number): void {
		this.registers[addr & 15] = value & 0xff;
		this.sinceUpdate = UPDATE_INTERVAL;
	}

	read(addr: number): number {
		return this.registers[addr & 15];
	}

	setMuted(_channel: number, muted: boolean): void {
		this.muted = muted;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const r = SPEECH_REGISTERS;
		const f0 = this.read16(r.F0) / 16;
		const voice = this.registers[r.VOICE] / 255;
		const noise = this.registers[r.NOISE] / 255;
		const source: SourceShape = this.registers[r.CONTROL] & 1 ? 'saw' : 'glottal';
		for (let i = 0; i < count; i++) {
			if (this.sinceUpdate >= UPDATE_INTERVAL) {
				this.resonators[0].set(this.read16(r.F1), this.registers[r.B1] * 4, this.sampleRate);
				this.resonators[1].set(this.read16(r.F2), this.registers[r.B2] * 4, this.sampleRate);
				this.resonators[2].set(this.read16(r.F3), this.registers[r.B3] * 4, this.sampleRate);
				this.sinceUpdate = 0;
			}
			this.sinceUpdate++;
			let s = 0;
			if (f0 > 0) {
				this.phase += f0 / this.sampleRate;
				if (this.phase >= 1) this.phase -= 1;
				s += voice * glottalPulse(this.phase, source);
			}
			if (noise > 0) {
				this.noiseState = (Math.imul(this.noiseState, 1664525) + 1013904223) >>> 0;
				s += noise * (this.noiseState / 0x80000000 - 1);
			}
			for (const resonator of this.resonators) s = resonator.process(s);
			for (const resonator of this.upper) s = resonator.process(s);
			if (!this.muted) {
				left[start + i] += s;
				right[start + i] += s;
			}
		}
	}

	private read16(addr: number): number {
		return this.registers[addr] | (this.registers[addr + 1] << 8);
	}

	private write16(addr: number, value: number): void {
		this.registers[addr] = value & 0xff;
		this.registers[addr + 1] = value >> 8;
	}
}

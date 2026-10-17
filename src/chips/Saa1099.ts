import { BoxRenderer } from './BoxRenderer.ts';
import type { Chip, ChipOptions } from './Chip.ts';

export interface Saa1099Options extends ChipOptions {
	/** noise generators of the chip are tied to its clock: 7.15909 MHz on the Game Blaster / C-MS, 8 MHz nominal */
}

/** envelope waveforms of the SAA1099 (register 0x18/0x19 bits 1-3) as 16 step shapes */
function envelopeShape(kind: number, step: number): number {
	const s = step & 31; // 0..31, one pass = 16 steps up or down
	switch (kind) {
		case 0:
			return 0;
		case 1:
			return 15;
		case 2:
			return s < 16 ? 15 - s : 0; // single decay
		case 3:
			return 15 - (s & 15); // repeated decay
		case 4:
			return s < 16 ? s : 15 - (s - 16) >= 0 ? 31 - s : 0; // single triangle
		case 5:
			return s < 16 ? s : 31 - s; // repeated triangle
		case 6:
			return s < 16 ? s : 15; // single attack, then held
		default:
			return s & 15; // repeated attack
	}
}

/**
 * Philips SAA1099 sound generator, two of which formed the Creative Music System / Game Blaster (12 voices). Six
 * square-wave channels with 8 bit frequency + 3 bit octave, two noise generators, two envelope generators and
 * 4 bit amplitudes for the left and the right output. Register addresses 0x00-0x1C are the chip's.
 *
 * Frequency of a channel: `clock / 512 * 2^octave / (511 - frequency)`. Approximations: the envelope clock modes
 * are reduced to the internal rate and to "follows channel 1 / 4", and the noise register is a 17 bit LFSR
 * (see CONFORMANCE.md).
 */
export class Saa1099 extends BoxRenderer implements Chip {
	readonly id = 'saa1099';
	readonly name = 'Philips SAA1099';
	readonly channels = 6;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly freq = new Uint8Array(6);
	private readonly amp = new Uint8Array(6);
	private readonly oct = new Uint8Array(6);
	private freqEnable = 0;
	private noiseEnable = 0;
	private noiseClock = [0, 0];
	private env = [0, 0];
	private soundOn = true;
	private readonly counter = new Float64Array(6);
	private readonly level = new Uint8Array(6).fill(1);
	private noiseShift = [1, 1];
	private noiseCounter = [0, 0];
	private readonly envStep = [0, 0];
	private readonly envCounter = [0, 0];
	private readonly muted = new Array<boolean>(6).fill(false);
	private addrLatch = 0;

	constructor(options: Saa1099Options = {}) {
		const sampleRate = options.sampleRate ?? 44100;
		const clock = options.clock ?? 7_159_090;
		// internal step: clock / 4 (the tone half-period of the highest octave is below that)
		super(clock / 4 / sampleRate);
		this.clock = clock;
		this.sampleRate = sampleRate;
		this.reset();
	}

	reset(): void {
		this.freq.fill(0);
		this.amp.fill(0);
		this.oct.fill(0);
		this.freqEnable = this.noiseEnable = 0;
		this.noiseClock = [0, 0];
		this.env = [0, 0];
		this.soundOn = false;
		this.counter.fill(0);
		this.level.fill(1);
		this.noiseShift = [1, 1];
		this.noiseCounter = [0, 0];
		this.envStep[0] = this.envStep[1] = 0;
		this.envCounter[0] = this.envCounter[1] = 0;
		this.resetBox();
	}

	/** select the register (as the address port does) for a following `write(1, value)` data write */
	write(addr: number, value: number): void {
		const v = value & 0xff;
		// two-port style: addr 0 = data, addr 1 = address latch (as on the C/MS: port + 1 is the address)
		if (addr === 0x100) return void (this.addrLatch = v & 0x1f);
		const reg = addr & 0x1f;
		if (addr < 0x20 || addr === 0x101) this.reg(addr === 0x101 ? this.addrLatch : reg, v);
	}

	private reg(r: number, v: number): void {
		if (r <= 5) this.amp[r] = v;
		else if (r >= 8 && r <= 13) this.freq[r - 8] = v;
		else if (r >= 0x10 && r <= 0x12) {
			const c = (r - 0x10) * 2;
			this.oct[c] = v & 7;
			this.oct[c + 1] = (v >> 4) & 7;
		} else if (r === 0x14) this.freqEnable = v & 0x3f;
		else if (r === 0x15) this.noiseEnable = v & 0x3f;
		else if (r === 0x16) this.noiseClock = [v & 3, (v >> 4) & 3];
		else if (r === 0x18) {
			this.env[0] = v;
			if (!(v & 0x80)) this.envStep[0] = 0;
		} else if (r === 0x19) {
			this.env[1] = v;
			if (!(v & 0x80)) this.envStep[1] = 0;
		} else if (r === 0x1c) {
			this.soundOn = (v & 1) !== 0;
			if (v & 2) {
				this.counter.fill(0);
				this.level.fill(1);
			}
		}
	}

	read(): number {
		return 0;
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 6) this.muted[channel] = muted;
	}

	/** toggle interval of a channel in internal steps */
	private interval(ch: number): number {
		// half period in steps of clock/4: (clock/4) / (2 * clock/512 * 2^oct / (511 - f)) = 64 * (511 - f) / 2^oct
		return (64 * (511 - this.freq[ch])) / (1 << this.oct[ch]);
	}

	private noiseSource(gen: number): number {
		const mode = this.noiseClock[gen];
		return mode === 0 ? 4 : mode === 1 ? 8 : mode === 2 ? 16 : 0; // steps per noise clock: 31.25 / 15.6 / 7.8 kHz at 8 MHz
	}

	protected step(): void {
		for (let ch = 0; ch < 6; ch++) {
			this.counter[ch] -= 1;
			let guard = 0;
			while (this.counter[ch] <= 0 && guard++ < 64) {
				this.counter[ch] += Math.max(0.5, this.interval(ch));
				this.level[ch] ^= 1;
				// noise generator 0 variable clock follows channel 0, generator 1 follows channel 3
				if (
					this.level[ch] &&
					((ch === 0 && this.noiseClock[0] === 3) || (ch === 3 && this.noiseClock[1] === 3))
				) {
					this.clockNoise(ch === 0 ? 0 : 1);
				}
				// envelope clocked by channels 1 / 4 when the external clock mode is selected
				if (this.level[ch] && (ch === 1 || ch === 4) && this.env[ch === 1 ? 0 : 1] & 0x20)
					this.stepEnvelope(ch === 1 ? 0 : 1);
			}
		}
		for (let g = 0; g < 2; g++) {
			const period = this.noiseSource(g);
			if (period && --this.noiseCounter[g] <= 0) {
				this.noiseCounter[g] = period;
				this.clockNoise(g);
			}
			if (!(this.env[g] & 0x20) && this.env[g] & 0x80 && --this.envCounter[g] <= 0) {
				this.envCounter[g] = 8;
				this.stepEnvelope(g);
			}
		}
		let l = 0;
		let r = 0;
		if (this.soundOn) {
			for (let ch = 0; ch < 6; ch++) {
				if (this.muted[ch]) continue;
				const gen = ch < 3 ? 0 : 1;
				const noiseBit = this.noiseShift[gen] & 1;
				let on = 0;
				if (this.freqEnable & (1 << ch)) on += this.level[ch];
				if (this.noiseEnable & (1 << ch)) on += noiseBit;
				if (!on) continue;
				let al = this.amp[ch] & 15;
				let ar = this.amp[ch] >> 4;
				if ((ch === 2 || ch === 5) && this.env[ch === 2 ? 0 : 1] & 0x80) {
					const e = envelopeShape((this.env[ch === 2 ? 0 : 1] >> 1) & 7, this.envStep[ch === 2 ? 0 : 1]);
					al = (al * e) / 15;
					ar = (ar * e) / 15;
					if (this.env[ch === 2 ? 0 : 1] & 1) [al, ar] = [ar, al];
				}
				l += on * al;
				r += on * ar;
			}
		}
		// 6 channels x 15 x up to 2 sources: keep headroom
		this.curL = l / 120;
		this.curR = r / 120;
	}

	private clockNoise(g: number): void {
		const s = this.noiseShift[g];
		const bit = ((s >> 16) ^ (s >> 13)) & 1;
		this.noiseShift[g] = ((s << 1) | bit) & 0x1ffff || 1;
	}

	private stepEnvelope(g: number): void {
		const kind = (this.env[g] >> 1) & 7;
		// single shapes hold their last value
		if ((kind === 2 || kind === 4 || kind === 6) && this.envStep[g] >= 31) return;
		this.envStep[g]++;
	}
}

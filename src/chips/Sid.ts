import { BoxRenderer } from './BoxRenderer.ts';
import type { Chip, ChipOptions } from './Chip.ts';

/** ADSR rate counter periods (PHI2 cycles per envelope step) for the 16 attack values; decay and release are 3x slower */
const RATE_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
/** the exponential decay approximation of the real chip: counter value -> extra division of the rate */
function expPeriod(counter: number): number {
	if (counter === 0xff) return 1;
	if (counter >= 0x5d) return 2;
	if (counter >= 0x36) return 4;
	if (counter >= 0x1a) return 8;
	if (counter >= 0x0e) return 16;
	if (counter >= 0x06) return 30;
	return 1;
}

export interface SidOptions extends ChipOptions {
	/** 'mos6581' (default: older, strong filter nonlinearity and DC offset) or 'mos8580' (clean) */
	model?: 'mos6581' | 'mos8580';
}

class Voice {
	acc = 0; // 24 bit phase accumulator
	freq = 0;
	pw = 0;
	control = 0;
	attack = 0;
	decay = 0;
	sustain = 0;
	release = 0;
	shift = 0x7ffff8; // 23 bit noise LFSR
	prevMsb = false;
	envState: 'attack' | 'decay' | 'release' = 'release';
	gate = false;
	env = 0;
	rateCounter = 0;
	expCounter = 0;
	holdZero = true;
	out = 0;
	muted = false;
}

/**
 * MOS 6581 / 8580 SID: three voices of 24 bit phase accumulators with triangle, sawtooth, pulse (12 bit width) and
 * noise (23 bit LFSR) waveforms, hard sync, ring modulation, a true ADSR (rate counters with the exponential decay
 * approximation) and the multimode state-variable filter (low / band / high pass, resonance, voice routing, 3 off).
 * Register addresses 0-28 as on the real chip.
 *
 * Approximations (see CONFORMANCE.md): combined waveforms are modelled as the bitwise AND of their parts instead of
 * the measured analog tables, and the filter is a floating point state-variable filter with the cut-off curves of
 * the two models rather than a transistor-level model.
 */
export class Sid extends BoxRenderer implements Chip {
	readonly id = 'sid';
	readonly name: string;
	readonly channels = 3;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly regs = new Uint8Array(32);
	private readonly v = [new Voice(), new Voice(), new Voice()];
	private readonly model: 'mos6581' | 'mos8580';
	private fcReg = 0;
	private res = 0;
	private filt = 0;
	private mode = 0;
	private volume = 0;
	private low = 0;
	private band = 0;
	private high = 0;
	private extIn = 0;
	private get dcLevel(): number {
		return this.model === 'mos6581' ? 0.35 : 0.03;
	}

	constructor(options: SidOptions = {}) {
		const sampleRate = options.sampleRate ?? 44100;
		const clock = options.clock ?? 985_248;
		super(clock / sampleRate);
		this.clock = clock;
		this.sampleRate = sampleRate;
		this.model = options.model ?? 'mos6581';
		this.name = this.model === 'mos6581' ? 'MOS 6581 SID' : 'MOS 8580 SID';
		this.reset();
	}

	reset(): void {
		this.regs.fill(0);
		for (const v of this.v) Object.assign(v, new Voice(), { muted: v.muted });
		this.fcReg = this.res = this.filt = this.mode = this.volume = 0;
		this.low = this.band = this.high = 0;
		this.resetBox();
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 3) this.v[channel].muted = muted;
	}

	write(addr: number, value: number): void {
		const a = addr & 31;
		const x = value & 0xff;
		this.regs[a] = x;
		if (a < 21) {
			const v = this.v[Math.floor(a / 7)];
			switch (a % 7) {
				case 0:
					v.freq = (v.freq & 0xff00) | x;
					break;
				case 1:
					v.freq = (v.freq & 0xff) | (x << 8);
					break;
				case 2:
					v.pw = (v.pw & 0xf00) | x;
					break;
				case 3:
					v.pw = (v.pw & 0xff) | ((x & 15) << 8);
					break;
				case 4: {
					const gate = (x & 1) !== 0;
					if (gate && !v.gate) {
						v.envState = 'attack';
						v.holdZero = false;
					} else if (!gate && v.gate) v.envState = 'release';
					v.gate = gate;
					if (x & 8) {
						v.acc = 0; // test bit holds the oscillator at zero and reloads the noise register
						v.shift = 0x7ffff8;
					}
					v.control = x;
					break;
				}
				case 5:
					v.attack = x >> 4;
					v.decay = x & 15;
					break;
				case 6:
					v.sustain = (x >> 4) * 17;
					v.release = x & 15;
					break;
			}
		} else if (a === 21 || a === 22) {
			this.fcReg = (this.regs[21] & 7) | (this.regs[22] << 3);
		} else if (a === 23) {
			this.res = x >> 4;
			this.filt = x & 15;
		} else if (a === 24) {
			this.volume = x & 15;
			this.mode = x >> 4;
		}
	}

	read(addr: number): number {
		const a = addr & 31;
		if (a === 27) return this.waveform(this.v[2], this.v[1]) >> 4;
		if (a === 28) return this.v[2].env;
		return 0;
	}

	/** one PHI2 cycle for oscillator and envelope of a voice; `src` is the voice that syncs / ring-modulates it */
	private clockVoice(v: Voice): void {
		const ctrl = v.control;
		if (ctrl & 8) {
			v.acc = 0;
		} else {
			const prev = v.acc;
			v.acc = (v.acc + v.freq) & 0xffffff;
			// the noise register shifts when bit 19 of the accumulator goes high
			if (!(prev & 0x080000) && v.acc & 0x080000) {
				const bit = ((v.shift >> 22) ^ (v.shift >> 17)) & 1;
				v.shift = ((v.shift << 1) | bit) & 0x7fffff;
			}
		}
		// ADSR
		const rate = v.envState === 'attack' ? v.attack : v.envState === 'decay' ? v.decay : v.release;
		const period = RATE_PERIOD[rate];
		if (++v.rateCounter >= period) {
			v.rateCounter = 0;
			if (v.envState === 'attack') {
				if (v.env < 255) v.env++;
				if (v.env === 255) v.envState = 'decay';
			} else if (!v.holdZero && ++v.expCounter >= expPeriod(v.env)) {
				v.expCounter = 0;
				if (v.envState === 'decay') {
					if (v.env > v.sustain) v.env--;
				} else if (v.env > 0) v.env--;
				if (v.env === 0) v.holdZero = true;
			}
		}
	}

	/** 12 bit waveform of a voice at the current accumulator value */
	private waveform(v: Voice, src: Voice): number {
		const ctrl = v.control;
		const sel = ctrl >> 4;
		if (sel === 0) return 0;
		const acc = v.acc;
		let out = 0xfff;
		let used = false;
		if (sel & 1) {
			// triangle, with ring modulation by the previous voice's MSB
			let tri = (acc >> 12) & 0x7ff;
			const flip = ((acc & 0x800000) !== 0) !== (ctrl & 4 ? (src.acc & 0x800000) !== 0 : false);
			if (flip) tri ^= 0x7ff;
			out &= tri << 1;
			used = true;
		}
		if (sel & 2) {
			out &= acc >> 12;
			used = true;
		}
		if (sel & 4) {
			out &= acc >> 12 >= v.pw || ctrl & 8 ? 0xfff : 0;
			used = true;
		}
		if (sel & 8) {
			const s = v.shift;
			const n =
				(((s >> 22) & 1) << 11) |
				(((s >> 20) & 1) << 10) |
				(((s >> 16) & 1) << 9) |
				(((s >> 13) & 1) << 8) |
				(((s >> 11) & 1) << 7) |
				(((s >> 7) & 1) << 6) |
				(((s >> 4) & 1) << 5) |
				(((s >> 2) & 1) << 4);
			out &= n;
			used = true;
		}
		return used ? out : 0;
	}

	protected step(): void {
		const [v0, v1, v2] = this.v;
		// hard sync: a voice's oscillator restarts when its source voice's MSB rises (source of voice N is N-1)
		const msb = [(v0.acc & 0x800000) !== 0, (v1.acc & 0x800000) !== 0, (v2.acc & 0x800000) !== 0];
		this.clockVoice(v0);
		this.clockVoice(v1);
		this.clockVoice(v2);
		const rises = [v0, v1, v2].map((v, i) => !msb[i] && (v.acc & 0x800000) !== 0);
		if (v1.control & 2 && rises[0]) v1.acc = 0;
		if (v2.control & 2 && rises[1]) v2.acc = 0;
		if (v0.control & 2 && rises[2]) v0.acc = 0;

		let direct = 0;
		let filtered = 0;
		const srcs = [v2, v0, v1];
		for (let i = 0; i < 3; i++) {
			const v = this.v[i];
			const wave = this.waveform(v, srcs[i]);
			// 12 bit waveform centred, scaled by the 8 bit envelope: range about +-1
			const s = v.muted ? 0 : ((wave - 2048) / 2048) * (v.env / 255);
			if (this.filt & (1 << i)) filtered += s;
			else if (!(i === 2 && this.mode & 8)) direct += s; // voice 3 off disconnects it from the output
		}
		this.extIn = 0;
		if (this.filt & 8) filtered += this.extIn;
		this.stepFilter(filtered);
		let out = direct;
		if (this.mode & 1) out += this.low;
		if (this.mode & 2) out += this.band;
		if (this.mode & 4) out += this.high;
		// the analogue outputs sit on a DC level that the master volume scales: changing the volume register is how
		// 4 bit digitised sound was played (strong on the 6581, faint on the 8580)
		this.curL = this.curR = ((out + this.dcLevel) * this.volume) / 15 / 3;
	}

	/** state-variable filter, stepped once per PHI2 cycle at a 1/16 reduced rate for speed */
	private fdiv = 0;
	private stepFilter(input: number): void {
		if (++this.fdiv < 16) return;
		this.fdiv = 0;
		const fc = this.fcReg;
		// cut-off curves: the 6581 is roughly exponential and never above ~12 kHz, the 8580 is linear up to ~12.5 kHz
		const hz = this.model === 'mos6581' ? 30 + 11000 * (fc / 2047) ** 1.7 : 12500 * (fc / 2047) + 20;
		const w = Math.min(0.9, (2 * Math.PI * hz) / (this.clock / 16));
		const q = 1 / (0.707 + (this.res / 15) * 7);
		this.high = input - this.low - q * this.band;
		this.band += w * this.high;
		this.low += w * this.band;
	}
}

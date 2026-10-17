import { SincResampler } from '../driver/Resampler.ts';
import type { Chip, ChipOptions } from './Chip.ts';
import { egIncrement, expLevel, sineLevel } from './fm.ts';

const MUL2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];
const DT2_CENTS = [0, 600, 781, 950];
/** semitone of the 4 bit note code inside an octave (codes 3, 7, 11 and 15 are unused): C# first, C last */
const NOTE_SEMI = [1, 2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 9, 10, 11, 12, 12];
const DT1_TABLE = [
	[0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7],
	[0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14],
	[0, 0, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16, 16, 16, 16, 16],
];
const OFF = 0;
const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;

class Op {
	dt1 = 0;
	dt2 = 0;
	mul2 = 1;
	tl = 127;
	ks = 0;
	ar = 0;
	am = false;
	d1r = 0;
	d2r = 0;
	d1l = 0;
	rr = 0;
	phase = 0;
	env = 1023;
	state = OFF;
	key = false;
	out = 0;
}

class Chan {
	readonly ops = [new Op(), new Op(), new Op(), new Op()]; // logical order op1..op4
	kc = 0;
	kf = 0;
	alg = 0;
	fb = 0;
	pan = 3;
	pms = 0;
	ams = 0;
	prev1 = 0;
	prev2 = 0;
}

/**
 * Yamaha YM2151 (OPM): eight 4-operator FM channels with the 8 algorithms of the OPN family, feedback, DT1 / DT2
 * detune, key code + key fraction pitch (the 12 note chromatic code of the DX21 / TX81Z family), LFO (4 waveforms)
 * with PM and AM depth, the noise generator on channel 8 and stereo panning. Found in arcade boards, the Sharp
 * X68000, the Atari ST "Mega" arcade conversions and Yamaha DX21 / DX27 / TX81Z keyboards.
 *
 * Two register ports: `write(0, reg)` selects the register, `write(1, value)` writes it; or directly
 * `write(0x100 | reg, value)`. Output at the native rate (clock / 64, 55930 Hz) resampled with a windowed sinc.
 * Approximation: detune and the LFO are modelled in floating point, the envelope uses the OPN rate patterns.
 */
export class Ym2151 implements Chip {
	readonly id = 'ym2151';
	readonly name = 'Yamaha YM2151 (OPM)';
	readonly channels = 8;
	readonly clock: number;
	readonly sampleRate: number;
	readonly nativeRate: number;
	private readonly chans = Array.from({ length: 8 }, () => new Chan());
	private readonly regs = new Uint8Array(256);
	private readonly resampler: SincResampler;
	private latch = 0;
	private egCounter = 0;
	private egDiv = 0;
	private lfoPhase = 0;
	private lfoFreq = 0;
	private lfoWave = 0;
	private pmd = 0;
	private amd = 0;
	private noiseEnable = false;
	private noiseFreq = 0;
	private noiseCount = 0;
	private noiseShift = 1;
	private readonly muted = new Array<boolean>(8).fill(false);

	constructor(options: ChipOptions = {}) {
		this.clock = options.clock ?? 3_579_545;
		this.sampleRate = options.sampleRate ?? 44100;
		this.nativeRate = this.clock / 64;
		this.resampler = new SincResampler(this.nativeRate, this.sampleRate, (l, r, n) => this.generate(l, r, n));
		this.reset();
	}

	reset(): void {
		this.regs.fill(0);
		for (const c of this.chans) {
			c.kc = c.kf = c.alg = c.fb = c.pms = c.ams = c.prev1 = c.prev2 = 0;
			c.pan = 3;
			for (const o of c.ops) Object.assign(o, new Op());
		}
		this.latch = 0;
		this.egCounter = this.egDiv = 0;
		this.lfoPhase = 0;
		this.lfoFreq = this.lfoWave = this.pmd = this.amd = 0;
		this.noiseEnable = false;
		this.noiseShift = 1;
		this.resampler.reset();
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 8) this.muted[channel] = muted;
	}

	read(): number {
		return 0;
	}

	write(addr: number, value: number): void {
		const v = value & 0xff;
		if (addr === 0) return void (this.latch = v);
		if (addr === 1) return this.reg(this.latch, v);
		this.reg(addr & 0xff, v);
	}

	private reg(r: number, v: number): void {
		this.regs[r] = v;
		if (r < 0x20) {
			switch (r) {
				case 0x08: {
					const c = this.chans[v & 7];
					for (let slot = 0; slot < 4; slot++)
						this.setKey(c.ops[[0, 2, 1, 3][slot]], (v & (8 << slot)) !== 0);
					break;
				}
				case 0x0f:
					this.noiseEnable = (v & 0x80) !== 0;
					this.noiseFreq = v & 0x1f;
					break;
				case 0x18:
					this.lfoFreq = v;
					break;
				case 0x19:
					if (v & 0x80) this.pmd = v & 0x7f;
					else this.amd = v & 0x7f;
					break;
				case 0x1b:
					this.lfoWave = v & 3;
					break;
			}
			return;
		}
		const ch = this.chans[r & 7];
		if (r < 0x28) {
			ch.pan = v >> 6;
			ch.fb = (v >> 3) & 7;
			ch.alg = v & 7;
		} else if (r < 0x30) ch.kc = v & 0x7f;
		else if (r < 0x38) ch.kf = v >> 2;
		else if (r < 0x40) {
			ch.pms = (v >> 4) & 7;
			ch.ams = v & 3;
		} else {
			const o = ch.ops[[0, 2, 1, 3][(r >> 3) & 3]];
			switch (r & 0xe0) {
				case 0x40:
					o.dt1 = (v >> 4) & 7;
					o.mul2 = MUL2[v & 15];
					break;
				case 0x60:
					o.tl = v & 0x7f;
					break;
				case 0x80:
					o.ks = v >> 6;
					o.ar = v & 0x1f;
					break;
				case 0xa0:
					o.am = (v & 0x80) !== 0;
					o.d1r = v & 0x1f;
					break;
				case 0xc0:
					o.dt2 = v >> 6;
					o.d2r = v & 0x1f;
					break;
				case 0xe0:
					o.d1l = v >> 4;
					o.rr = v & 15;
					break;
			}
		}
	}

	private setKey(o: Op, on: boolean): void {
		if (on && !o.key) {
			o.state = ATTACK;
			o.phase = 0;
		} else if (!on && o.key && o.state !== OFF) o.state = RELEASE;
		o.key = on;
	}

	/** pitch of a channel in Hz from key code and key fraction (A4 = KC 0x4A = 440 Hz at 3.579545 MHz) */
	private channelHz(c: Chan): number {
		const octave = (c.kc >> 4) & 7;
		const semi = octave * 12 + NOTE_SEMI[c.kc & 15];
		return 440 * 2 ** ((semi - 57 + c.kf / 64) / 12) * (this.clock / 3_579_545);
	}

	private keyCodeFor(c: Chan): number {
		return Math.min(31, ((c.kc >> 4) & 7) * 4 + (((c.kc & 15) >> 2) & 3));
	}

	private envelope(o: Op, kcode: number): void {
		const rateOf = (r: number): number => (r === 0 ? 0 : Math.min(63, 2 * r + (kcode >> (3 - o.ks))));
		switch (o.state) {
			case ATTACK: {
				const rate = rateOf(o.ar);
				if (rate >= 62) {
					o.env = 0;
					o.state = DECAY;
					return;
				}
				const inc = egIncrement(rate, this.egCounter, 11);
				if (inc) o.env += (~o.env * inc) >> 4;
				if (o.env <= 0) {
					o.env = 0;
					o.state = DECAY;
				}
				return;
			}
			case DECAY: {
				o.env = Math.min(1023, o.env + egIncrement(rateOf(o.d1r), this.egCounter, 11));
				const sl = o.d1l === 15 ? 992 : o.d1l << 5;
				if (o.env >= sl) {
					o.env = Math.min(o.env, sl);
					o.state = SUSTAIN;
				}
				return;
			}
			case SUSTAIN:
				o.env = Math.min(1023, o.env + egIncrement(rateOf(o.d2r), this.egCounter, 11));
				return;
			case RELEASE:
				o.env = Math.min(
					1023,
					o.env + egIncrement(Math.min(63, 4 * o.rr + 2 + (kcode >> (3 - o.ks))), this.egCounter, 11),
				);
				if (o.env >= 1023) o.state = OFF;
		}
	}

	private opOut(o: Op, mod: number, amTrem: number, noise = -1): number {
		const env = Math.min(1023, o.env + (o.tl << 3) + (o.am ? amTrem : 0));
		if (noise >= 0) return (noise ? 1 : -1) * expLevel(env << 2);
		const s = sineLevel(((o.phase >> 10) & 0x3ff) + mod);
		const a = expLevel((s & 0xffff) + (env << 2));
		return s & 0x10000 ? -a : a;
	}

	private generate(left: Float32Array, right: Float32Array, n: number): void {
		const lfoRate = 0.0007 * 2 ** (this.lfoFreq / 16) * 100; // 0.008 .. 52 Hz range, in cycles per second (approx.)
		for (let i = 0; i < n; i++) {
			if (++this.egDiv >= 3) {
				this.egDiv = 0;
				this.egCounter++;
				for (const c of this.chans) {
					const kcode = this.keyCodeFor(c);
					for (const o of c.ops) this.envelope(o, kcode);
				}
			}
			// LFO: value in -1..1 (PM) and 0..1 (AM)
			this.lfoPhase = (this.lfoPhase + lfoRate / this.nativeRate) % 1;
			let wave: number;
			switch (this.lfoWave) {
				case 0:
					wave = 1 - this.lfoPhase * 2;
					break;
				case 1:
					wave = this.lfoPhase < 0.5 ? 1 : -1;
					break;
				case 2:
					wave = this.lfoPhase < 0.5 ? 1 - this.lfoPhase * 4 : this.lfoPhase * 4 - 3;
					break;
				default:
					wave = ((this.noiseShift >> 3) & 1) * 2 - 1;
			}
			const am = ((1 - wave) / 2) * (this.amd / 127) * 126; // attenuation units of 0.75 dB x 8 / 8
			const pm = wave * (this.pmd / 127);
			// noise generator
			if (this.noiseEnable && ++this.noiseCount >= 32 - this.noiseFreq) {
				this.noiseCount = 0;
				const bit = ((this.noiseShift >> 0) ^ (this.noiseShift >> 3)) & 1;
				this.noiseShift = (this.noiseShift >> 1) | (bit << 16);
			}
			let l = 0;
			let r = 0;
			for (let ci = 0; ci < 8; ci++) {
				const c = this.chans[ci];
				const out = this.channel(c, ci === 7 && this.noiseEnable ? this.noiseShift & 1 : -1, am, pm);
				if (this.muted[ci]) continue;
				const v = out / (8192 * 2.4);
				if (c.pan & 2) l += v;
				if (c.pan & 1) r += v;
			}
			left[i] = l;
			right[i] = r;
		}
	}

	private channel(c: Chan, noise: number, am: number, pm: number): number {
		const hz = this.channelHz(c) * 2 ** ((pm * c.pms * 0.6) / 12);
		const kcode = this.keyCodeFor(c);
		for (const o of c.ops) {
			const detuned = hz * 2 ** (DT2_CENTS[o.dt2] / 1200);
			let inc = (detuned * (o.mul2 / 2) * 2 ** 20) / this.nativeRate;
			const dt = o.dt1 & 3 ? DT1_TABLE[(o.dt1 & 3) - 1][kcode] * (o.dt1 & 4 ? -1 : 1) : 0;
			inc += dt;
			if (inc < 0) inc += 0x100000;
			o.phase = (o.phase + inc) % 0x100000;
		}
		const [o1, o2, o3, o4] = c.ops;
		const amTrem = c.ams ? am * (c.ams / 3) : 0;
		const fbmod = c.fb ? (c.prev1 + c.prev2) >> (10 - c.fb) : 0;
		const a = this.opOut(o1, fbmod, amTrem);
		c.prev2 = c.prev1;
		c.prev1 = a;
		o1.out = a;
		const last = (o: Op, mod: number): number => this.opOut(o, mod, amTrem, noise);
		let out: number;
		switch (c.alg) {
			case 0:
				o2.out = this.opOut(o2, o1.out, amTrem);
				o3.out = this.opOut(o3, o2.out, amTrem);
				out = o4.out = last(o4, o3.out);
				break;
			case 1:
				o2.out = this.opOut(o2, 0, amTrem);
				o3.out = this.opOut(o3, o1.out + o2.out, amTrem);
				out = o4.out = last(o4, o3.out);
				break;
			case 2:
				o2.out = this.opOut(o2, 0, amTrem);
				o3.out = this.opOut(o3, o2.out, amTrem);
				out = o4.out = last(o4, o1.out + o3.out);
				break;
			case 3:
				o2.out = this.opOut(o2, o1.out, amTrem);
				o3.out = this.opOut(o3, 0, amTrem);
				out = o4.out = last(o4, o2.out + o3.out);
				break;
			case 4:
				o2.out = this.opOut(o2, o1.out, amTrem);
				o3.out = this.opOut(o3, 0, amTrem);
				o4.out = last(o4, o3.out);
				out = o2.out + o4.out;
				break;
			case 5:
				o2.out = this.opOut(o2, o1.out, amTrem);
				o3.out = this.opOut(o3, o1.out, amTrem);
				o4.out = last(o4, o1.out);
				out = o2.out + o3.out + o4.out;
				break;
			case 6:
				o2.out = this.opOut(o2, o1.out, amTrem);
				o3.out = this.opOut(o3, 0, amTrem);
				o4.out = last(o4, 0);
				out = o2.out + o3.out + o4.out;
				break;
			default:
				o2.out = this.opOut(o2, 0, amTrem);
				o3.out = this.opOut(o3, 0, amTrem);
				o4.out = last(o4, 0);
				out = o1.out + o2.out + o3.out + o4.out;
		}
		return Math.max(-8192, Math.min(8191, out));
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.resampler.render(left, right, start, count);
	}
}

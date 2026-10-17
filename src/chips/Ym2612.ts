import { SincResampler } from '../driver/Resampler.ts';
import type { Chip, ChipOptions } from './Chip.ts';
import { egIncrement, expLevel, sineLevel } from './fm.ts';

const MUL2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];
/** detune tables by key code (DT 1-3); DT 4-7 are the negative of DT 0-3 */
const DT_TABLE = [
	[0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7],
	[0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14],
	[0, 0, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16, 16, 16, 16, 16],
];
const AMS_SHIFT = [8, 3, 1, 0]; // 0, 1.4, 5.9, 11.8 dB as right shifts of the 0..126 LFO amplitude
const PMS_CENTS = [0, 3.4, 6.7, 10, 14, 20, 40, 80];
const LFO_HZ = [3.98, 5.56, 6.02, 6.37, 6.88, 9.63, 48.1, 72.2];
const OFF = 0;
const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;

class Op {
	dt = 0;
	mul2 = 1;
	tl = 127;
	ks = 0;
	ar = 0;
	am = false;
	d1r = 0;
	d2r = 0;
	d1l = 0;
	rr = 0;
	ssg = 0;
	phase = 0;
	env = 1023;
	state = OFF;
	key = false;
	out = 0;
	incBase = 0;
	kc = 0;
}

class Chan {
	readonly ops = [new Op(), new Op(), new Op(), new Op()]; // logical order op1..op4
	fnum = 0;
	block = 0;
	alg = 0;
	fb = 0;
	pan = 3;
	ams = 0;
	pms = 0;
	/** ch3 special mode frequencies (per operator) */
	sfnum = [0, 0, 0, 0];
	sblock = [0, 0, 0, 0];
	prev1 = 0;
	prev2 = 0;
}

export interface Ym2612Options extends ChipOptions {
	/**
	 * Model the 9 bit DAC of the YM2612 (the "ladder effect": a dead zone around zero that makes quiet sounds
	 * crunchy). Off by default; the original YM3438 does not have it.
	 */
	ladder?: boolean;
	/**
	 * FM channels: 6 (default, YM2612 / YM2608) or 3 (YM2203). With 3 the second register bank is ignored and the DAC
	 * is absent.
	 */
	fmChannels?: 3 | 6;
	/** master clock divider giving the native sample rate: 144 (default, YM2612 / YM2608) or 72 (YM2203) */
	divider?: number;
	/** id reported by the chip (the OPN family members built on this core give their own) */
	id?: string;
}

/**
 * Yamaha YM2612 (OPN2) as used in the Sega Mega Drive / Genesis: six 4-operator FM channels with the 8 algorithms,
 * feedback, detune, key scaling, the ADSR with a second decay rate, LFO (tremolo and vibrato), channel 3 special
 * mode, stereo panning and the 8 bit DAC that replaces channel 6 for samples.
 *
 * Registers: `addr` 0-0xFF is port 0 (channels 1-3), 0x100-0x1FF port 1 (channels 4-6), as in VGM commands 0x52 /
 * 0x53. The DAC value is register 0x2A, enabled by bit 7 of register 0x2B.
 * Output is at the native rate (clock / 144, about 53267 Hz) resampled with a windowed-sinc filter.
 *
 * Approximations: SSG-EG is stored but not applied; the LFO is a floating point triangle (see CONFORMANCE.md).
 */
export class Ym2612 implements Chip {
	readonly id: string = 'ym2612';
	readonly name = 'Yamaha YM2612';
	readonly channels: number;
	readonly clock: number;
	readonly sampleRate: number;
	readonly nativeRate: number;
	private readonly chans: Chan[];
	private readonly nFm: number;
	private readonly resampler: SincResampler;
	private readonly regs = new Uint8Array(512);
	private readonly ladder: boolean;
	private egCounter = 0;
	private egDiv = 0;
	private lfoPhase = 0;
	private lfoOn = false;
	private lfoFreq = 0;
	private ch3Mode = 0;
	private dacOn = false;
	private dacValue = 0;
	private ta = 0;
	private tb = 0;
	private timerCtl = 0;
	private status = 0;
	private taCount = 0;
	private tbCount = 0;
	private readonly muted: boolean[];

	constructor(options: Ym2612Options = {}) {
		this.clock = options.clock ?? 7_670_454;
		this.sampleRate = options.sampleRate ?? 44100;
		this.nFm = options.fmChannels ?? 6;
		this.channels = this.nFm;
		this.chans = Array.from({ length: this.nFm }, () => new Chan());
		this.muted = new Array<boolean>(this.nFm).fill(false);
		this.nativeRate = this.clock / (options.divider ?? 144);
		if (options.id) (this as { id: string }).id = options.id;
		this.ladder = options.ladder ?? false;
		this.resampler = new SincResampler(this.nativeRate, this.sampleRate, (l, r, n) => this.generate(l, r, n));
		this.reset();
	}

	reset(): void {
		this.regs.fill(0);
		for (const c of this.chans) {
			c.fnum = c.block = c.alg = c.fb = c.ams = c.pms = 0;
			c.pan = 3;
			c.prev1 = c.prev2 = 0;
			c.sfnum = [0, 0, 0, 0];
			c.sblock = [0, 0, 0, 0];
			for (const o of c.ops) {
				Object.assign(o, {
					dt: 0,
					mul2: 1,
					tl: 127,
					ks: 0,
					ar: 0,
					am: false,
					d1r: 0,
					d2r: 0,
					d1l: 0,
					rr: 0,
					ssg: 0,
					phase: 0,
					env: 1023,
					state: OFF,
					key: false,
					out: 0,
					incBase: 0,
					kc: 0,
				});
			}
		}
		this.egCounter = this.egDiv = 0;
		this.lfoPhase = 0;
		this.lfoOn = false;
		this.lfoFreq = 0;
		this.ch3Mode = 0;
		this.dacOn = false;
		this.dacValue = 0;
		this.ta = this.tb = this.timerCtl = this.status = this.taCount = this.tbCount = 0;
		this.resampler.reset();
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 6) this.muted[channel] = muted;
	}

	read(addr: number): number {
		return (addr & 3) === 0 ? this.status : 0;
	}

	write(addr: number, value: number): void {
		const v = value & 0xff;
		const port = addr & 0x100 ? 1 : 0;
		const reg = addr & 0xff;
		this.regs[port * 256 + reg] = v;
		if (reg < 0x30) {
			if (port) return;
			this.writeGlobal(reg, v);
			return;
		}
		const chIdx = reg & 3;
		if (chIdx === 3) return;
		const c = this.chans[port * 3 + chIdx];
		if (!c) return;
		const opIdx = [0, 2, 1, 3][(reg >> 2) & 3]; // register slots are S1, S3, S2, S4
		if (reg < 0xa0) {
			const o = c.ops[opIdx];
			switch (reg & 0xf0) {
				case 0x30:
					o.dt = (v >> 4) & 7;
					o.mul2 = MUL2[v & 15];
					break;
				case 0x40:
					o.tl = v & 0x7f;
					break;
				case 0x50:
					o.ks = v >> 6;
					o.ar = v & 0x1f;
					break;
				case 0x60:
					o.am = (v & 0x80) !== 0;
					o.d1r = v & 0x1f;
					break;
				case 0x70:
					o.d2r = v & 0x1f;
					break;
				case 0x80:
					o.d1l = v >> 4;
					o.rr = v & 15;
					break;
				case 0x90:
					o.ssg = v & 15;
					break;
			}
			return;
		}
		switch (reg & 0xfc) {
			case 0xa0:
				c.fnum = ((this.regs[port * 256 + (reg | 4)] & 7) << 8) | v;
				c.block = (this.regs[port * 256 + (reg | 4)] >> 3) & 7;
				break;
			case 0xa4:
				// high bits are latched until the low byte is written
				break;
			case 0xa8:
				if (port === 0 && chIdx < 3) {
					const hi = this.regs[0xac + chIdx];
					this.chans[2].sfnum[[2, 3, 1][chIdx]] = ((hi & 7) << 8) | v;
					this.chans[2].sblock[[2, 3, 1][chIdx]] = (hi >> 3) & 7;
				}
				break;
			case 0xb0:
				if (reg === 0xb0 + chIdx) {
					c.alg = v & 7;
					c.fb = (v >> 3) & 7;
				}
				break;
			case 0xb4:
				c.pan = v >> 6;
				c.ams = (v >> 4) & 3;
				c.pms = v & 7;
				break;
		}
	}

	private writeGlobal(reg: number, v: number): void {
		switch (reg) {
			case 0x22:
				this.lfoOn = (v & 8) !== 0;
				this.lfoFreq = v & 7;
				break;
			case 0x24:
				this.ta = (this.ta & 3) | (v << 2);
				break;
			case 0x25:
				this.ta = (this.ta & 0x3fc) | (v & 3);
				break;
			case 0x26:
				this.tb = v;
				break;
			case 0x27:
				this.ch3Mode = v >> 6;
				if (v & 0x10) this.status &= ~1;
				if (v & 0x20) this.status &= ~2;
				if (v & 1 && !(this.timerCtl & 1)) this.taCount = 0;
				if (v & 2 && !(this.timerCtl & 2)) this.tbCount = 0;
				this.timerCtl = v;
				break;
			case 0x28: {
				const idx = v & 7;
				const chIdx = idx < 3 ? idx : idx - 1;
				if ((idx & 3) === 3 || chIdx >= this.nFm) return;
				const c = this.chans[chIdx];
				for (let i = 0; i < 4; i++) this.setKey(c.ops[[0, 2, 1, 3][i]], (v & (0x10 << i)) !== 0);
				break;
			}
			case 0x2a:
				this.dacValue = v;
				break;
			case 0x2b:
				this.dacOn = (v & 0x80) !== 0;
				break;
		}
	}

	private setKey(o: Op, on: boolean): void {
		if (on && !o.key) {
			o.state = ATTACK;
			o.phase = 0;
		} else if (!on && o.key && o.state !== OFF) o.state = RELEASE;
		o.key = on;
	}

	private keyCode(fnum: number, block: number): number {
		const b3 = (fnum >> 10) & 1;
		const b2 = (fnum >> 9) & 1;
		const b1 = (fnum >> 8) & 1;
		const b0 = (fnum >> 7) & 1;
		return (block << 2) | (b3 << 1) | ((b3 & (b2 | b1 | b0)) | (~b3 & 1 & (b2 & b1 & b0)));
	}

	private opFreq(c: Chan, i: number): { fnum: number; block: number } {
		if (c === this.chans[2] && this.ch3Mode) return { fnum: c.sfnum[i], block: c.sblock[i] };
		return { fnum: c.fnum, block: c.block };
	}

	private envelope(o: Op): void {
		const rateOf = (r: number): number => (r === 0 ? 0 : Math.min(63, 2 * r + (o.kc >> (3 - o.ks))));
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
					o.env + egIncrement(Math.min(63, 4 * o.rr + 2 + (o.kc >> (3 - o.ks))), this.egCounter, 11),
				);
				if (o.env >= 1023) o.state = OFF;
				return;
		}
	}

	private opOut(o: Op, mod: number, ams: number, lfoAm: number): number {
		const tremolo = o.am ? lfoAm >> AMS_SHIFT[ams] : 0;
		const env = Math.min(1023, o.env + (o.tl << 3) + tremolo * 1);
		const s = sineLevel(((o.phase >> 10) & 0x3ff) + mod);
		const a = expLevel((s & 0xffff) + (env << 2));
		return s & 0x10000 ? -a : a;
	}

	private generate(left: Float32Array, right: Float32Array, n: number): void {
		const lfoHz = LFO_HZ[this.lfoFreq];
		for (let i = 0; i < n; i++) {
			// EG runs every third sample
			if (++this.egDiv >= 3) {
				this.egDiv = 0;
				this.egCounter++;
				for (const c of this.chans) for (const o of c.ops) this.envelope(o);
			}
			let lfoAm = 0;
			let lfoPm = 0;
			if (this.lfoOn) {
				this.lfoPhase = (this.lfoPhase + lfoHz / this.nativeRate) % 1;
				const tri = this.lfoPhase < 0.5 ? this.lfoPhase * 2 : 2 - this.lfoPhase * 2; // 0..1
				lfoAm = Math.round(tri * 126);
				lfoPm = this.lfoPhase < 0.5 ? this.lfoPhase * 4 - 1 : 3 - this.lfoPhase * 4; // -1..1
			}
			// timers
			if (this.timerCtl & 1 && ++this.taCount >= ((1024 - this.ta) * 72) / 144) {
				this.taCount = 0;
				if (this.timerCtl & 4) this.status |= 1;
			}
			if (this.timerCtl & 2 && ++this.tbCount >= ((256 - this.tb) * 1152) / 144) {
				this.tbCount = 0;
				if (this.timerCtl & 8) this.status |= 2;
			}
			let l = 0;
			let r = 0;
			for (let ci = 0; ci < this.nFm; ci++) {
				const c = this.chans[ci];
				let out: number;
				if (ci === 5 && this.nFm === 6 && this.dacOn) out = (this.dacValue - 128) * 32;
				else out = this.channel(c, lfoAm, lfoPm);
				if (this.muted[ci]) continue;
				if (this.ladder) out = this.ladderDac(out);
				const v = out / (8192 * 2.2);
				if (this.nFm === 3 || c.pan & 2) l += v;
				if (this.nFm === 3 || c.pan & 1) r += v;
			}
			left[i] = l;
			right[i] = r;
		}
	}

	private ladderDac(out: number): number {
		const q = Math.trunc(out / 32); // 9 bit
		return (q + (q < 0 ? -1 : 0)) * 32;
	}

	private channel(c: Chan, lfoAm: number, lfoPm: number): number {
		const [o1, o2, o3, o4] = c.ops;
		const special = c === this.chans[2] && this.ch3Mode !== 0;
		for (let i = 0; i < 4; i++) {
			const o = c.ops[i];
			const f = special ? this.opFreq(c, i) : { fnum: c.fnum, block: c.block };
			o.kc = this.keyCode(f.fnum, f.block);
			let fnum = f.fnum;
			if (c.pms && this.lfoOn) fnum += Math.round(fnum * (PMS_CENTS[c.pms] / 1200) * 0.693 * lfoPm);
			let inc = (fnum << f.block) >> 1;
			const dtv = o.dt & 3 ? DT_TABLE[(o.dt & 3) - 1][o.kc] * (o.dt & 4 ? -1 : 1) : 0;
			inc = ((inc + dtv) * o.mul2) >> 1;
			if (inc < 0) inc += 0x100000;
			o.phase = (o.phase + inc) & 0xfffff;
		}
		const fbmod = c.fb ? (c.prev1 + c.prev2) >> (10 - c.fb) : 0;
		const ams = c.ams;
		const a = this.opOut(o1, fbmod, ams, lfoAm);
		c.prev2 = c.prev1;
		c.prev1 = a;
		o1.out = a;
		let out: number;
		switch (c.alg) {
			case 0:
				o2.out = this.opOut(o2, o1.out, ams, lfoAm);
				o3.out = this.opOut(o3, o2.out, ams, lfoAm);
				o4.out = this.opOut(o4, o3.out, ams, lfoAm);
				out = o4.out;
				break;
			case 1:
				o2.out = this.opOut(o2, 0, ams, lfoAm);
				o3.out = this.opOut(o3, o1.out + o2.out, ams, lfoAm);
				o4.out = this.opOut(o4, o3.out, ams, lfoAm);
				out = o4.out;
				break;
			case 2:
				o2.out = this.opOut(o2, 0, ams, lfoAm);
				o3.out = this.opOut(o3, o2.out, ams, lfoAm);
				o4.out = this.opOut(o4, o1.out + o3.out, ams, lfoAm);
				out = o4.out;
				break;
			case 3:
				o2.out = this.opOut(o2, o1.out, ams, lfoAm);
				o3.out = this.opOut(o3, 0, ams, lfoAm);
				o4.out = this.opOut(o4, o2.out + o3.out, ams, lfoAm);
				out = o4.out;
				break;
			case 4:
				o2.out = this.opOut(o2, o1.out, ams, lfoAm);
				o3.out = this.opOut(o3, 0, ams, lfoAm);
				o4.out = this.opOut(o4, o3.out, ams, lfoAm);
				out = o2.out + o4.out;
				break;
			case 5:
				o2.out = this.opOut(o2, o1.out, ams, lfoAm);
				o3.out = this.opOut(o3, o1.out, ams, lfoAm);
				o4.out = this.opOut(o4, o1.out, ams, lfoAm);
				out = o2.out + o3.out + o4.out;
				break;
			case 6:
				o2.out = this.opOut(o2, o1.out, ams, lfoAm);
				o3.out = this.opOut(o3, 0, ams, lfoAm);
				o4.out = this.opOut(o4, 0, ams, lfoAm);
				out = o2.out + o3.out + o4.out;
				break;
			default:
				o2.out = this.opOut(o2, 0, ams, lfoAm);
				o3.out = this.opOut(o3, 0, ams, lfoAm);
				o4.out = this.opOut(o4, 0, ams, lfoAm);
				out = o1.out + o2.out + o3.out + o4.out;
				break;
		}
		return Math.max(-8192, Math.min(8191, out));
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.resampler.render(left, right, start, count);
	}
}

import { SincResampler } from '../driver/Resampler.ts';
import type { Chip, ChipOptions } from './Chip.ts';
import { egIncrement, expLevel, LOGSIN } from './fm.ts';

/** frequency multipliers x2 (the 0.5 of multiplier 0 is why they are doubled) */
const MUL2 = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 30, 30];
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0];
const OFF = 0;
const ATTACK = 1;
const DECAY = 2;
const SUSTAIN = 3;
const RELEASE = 4;

/** channel -> first operator slot of the bank (the carrier is +3) */
function slotOf(offset: number): number {
	const i = offset & 7;
	const g = offset >> 3;
	return i >= 6 || g >= 3 ? -1 : g * 6 + i;
}

class Slot {
	am = false;
	vib = false;
	egt = false;
	ksr = false;
	mul2 = 1;
	kslIdx = 0;
	tl = 0;
	ar = 0;
	dr = 0;
	sl = 0;
	rr = 0;
	wf = 0;
	phase = 0;
	env = 511;
	state = OFF;
	keyChan = false;
	keyRhythm = false;
	out = 0;
	prout = 0;
	ksl = 0;
	kc = 0;
	chan!: Channel;
	muted = false;
}

class Channel {
	fnum = 0;
	block = 0;
	fb = 0;
	cnt = 0;
	cha = true;
	chb = true;
	/** 0: ordinary 2-op channel, 1: first channel of a 4-op pair, 2: second channel of a pair (silent) */
	four = 0;
	pair: Channel | null = null;
	slots: [Slot, Slot];
	constructor(
		a: Slot,
		b: Slot,
		readonly index: number,
	) {
		this.slots = [a, b];
		a.chan = this;
		b.chan = this;
	}
}

export interface OplOptions extends ChipOptions {
	/** 'opl2' (YM3812: 9 channels, 4 waveforms, mono, default) or 'opl3' (YMF262: 18 channels, 8 waveforms, stereo, 4-op) */
	variant?: 'opl2' | 'opl3';
	/** MIDI-style note on the real chip: set the first-channel pan of OPL3 voices through register $C0 (default true) */
	stereo?: boolean;
}

/**
 * Yamaha YM3812 (OPL2) and YMF262 (OPL3). Register addresses are the chip's: `addr` 0-0xFF is the first register
 * bank, 0x100-0x1FF the second bank of the OPL3 (as in the VGM / DRO conventions: port 1 = + 0x100).
 *
 * Model: 2-operator channels with the 4 (OPL2) or 8 (OPL3) waveforms, feedback, additive / FM connection, 4-operator
 * channels (OPL3), tremolo and vibrato LFOs (1 dB / 4.8 dB, 7 / 14 cent), key scaling of rate and level, the true
 * ADSR rate patterns and rhythm mode with the noise and phase interplay of the percussion slots.
 * Output is produced at the native rate (clock / 72, 49716 Hz) and resampled with a windowed-sinc filter.
 *
 * Approximations: rhythm-mode phase bits follow the documented XOR network, the envelope generator is
 * the sample-by-sample model of the common open-source cores rather than a gate-level one (see CONFORMANCE.md).
 */
export class Opl implements Chip {
	readonly id: string;
	readonly name: string;
	readonly channels: number;
	readonly clock: number;
	readonly sampleRate: number;
	readonly nativeRate: number;
	private readonly opl3: boolean;
	private readonly slots: Slot[] = [];
	private readonly ch: Channel[] = [];
	private readonly resampler: SincResampler;
	private newMode = false;
	private wse = false;
	private nts = false;
	private deepAm = false;
	private deepVib = false;
	private rhythm = false;
	private fourEnable = 0;
	private egCounter = 0;
	private lfoCounter = 0;
	private vibPos = 0;
	private noise = 1;
	private tremolo = 0;
	private readonly regs = new Uint8Array(512);
	private t1 = 0;
	private t2 = 0;
	private t1Count = 0;
	private t2Count = 0;
	private timerCtl = 0;
	private status = 0;
	private readonly muted: boolean[];

	constructor(options: OplOptions = {}) {
		const opl3 = options.variant === 'opl3';
		this.opl3 = opl3;
		this.id = opl3 ? 'opl3' : 'opl2';
		this.name = opl3 ? 'Yamaha YMF262 (OPL3)' : 'Yamaha YM3812 (OPL2)';
		this.clock = options.clock ?? (opl3 ? 14_318_180 : 3_579_545);
		this.sampleRate = options.sampleRate ?? 44100;
		this.nativeRate = this.clock / (opl3 ? 288 : 72);
		const nSlots = opl3 ? 36 : 18;
		for (let i = 0; i < nSlots; i++) this.slots.push(new Slot());
		const nCh = opl3 ? 18 : 9;
		this.channels = nCh;
		for (let c = 0; c < nCh; c++) {
			const bank = c >= 9 ? 18 : 0;
			const base = bank + Math.floor((c % 9) / 3) * 6 + (c % 3);
			this.ch.push(new Channel(this.slots[base], this.slots[base + 3], c));
		}
		this.muted = new Array<boolean>(nCh).fill(false);
		this.resampler = new SincResampler(this.nativeRate, this.sampleRate, (l, r, n) => this.generate(l, r, n));
		this.reset();
	}

	reset(): void {
		this.regs.fill(0);
		for (const s of this.slots) {
			Object.assign(s, {
				am: false,
				vib: false,
				egt: false,
				ksr: false,
				mul2: 1,
				kslIdx: 0,
				tl: 0,
				ar: 0,
				dr: 0,
				sl: 0,
				rr: 0,
				wf: 0,
				phase: 0,
				env: 511,
				state: OFF,
				keyChan: false,
				keyRhythm: false,
				out: 0,
				prout: 0,
				ksl: 0,
				kc: 0,
			});
		}
		for (const c of this.ch) {
			c.fnum = c.block = c.fb = c.cnt = 0;
			c.cha = c.chb = true;
			c.four = 0;
			c.pair = null;
		}
		this.newMode = this.wse = this.nts = this.deepAm = this.deepVib = this.rhythm = false;
		this.fourEnable = 0;
		this.egCounter = this.lfoCounter = this.vibPos = 0;
		this.noise = 1;
		this.tremolo = 0;
		this.t1 = this.t2 = this.t1Count = this.t2Count = this.timerCtl = this.status = 0;
		this.resampler.reset();
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < this.muted.length) this.muted[channel] = muted;
	}

	read(addr: number): number {
		if ((addr & 0xff) === 0) return this.status | (this.status & 0x60 ? 0x80 : 0);
		return this.regs[addr & 0x1ff];
	}

	write(addr: number, value: number): void {
		const v = value & 0xff;
		const bank = this.opl3 && addr & 0x100 ? 1 : 0;
		const reg = addr & 0xff;
		this.regs[bank * 256 + reg] = v;
		if (reg === 0x01 && !bank) {
			this.wse = (v & 0x20) !== 0;
			return;
		}
		if (reg === 0x02 && !bank) return void (this.t1 = v);
		if (reg === 0x03 && !bank) return void (this.t2 = v);
		if (reg === 0x04 && !bank) {
			if (v & 0x80) this.status = 0;
			else {
				this.timerCtl = v;
				if (v & 1) this.t1Count = 0;
				if (v & 2) this.t2Count = 0;
			}
			return;
		}
		if (reg === 0x04 && bank) {
			this.fourEnable = v & 0x3f;
			this.updateFourOp();
			return;
		}
		if (reg === 0x05 && bank) {
			this.newMode = (v & 1) !== 0;
			if (!this.newMode) this.updateFourOp();
			return;
		}
		if (reg === 0x08 && !bank) {
			this.nts = (v & 0x40) !== 0;
			return;
		}
		if (reg >= 0x20 && reg <= 0x35) {
			const s = this.slotAt(bank, reg - 0x20);
			if (!s) return;
			s.am = (v & 0x80) !== 0;
			s.vib = (v & 0x40) !== 0;
			s.egt = (v & 0x20) !== 0;
			s.ksr = (v & 0x10) !== 0;
			s.mul2 = MUL2[v & 15];
			this.refreshScaling(s.chan);
		} else if (reg >= 0x40 && reg <= 0x55) {
			const s = this.slotAt(bank, reg - 0x40);
			if (!s) return;
			s.kslIdx = v >> 6;
			s.tl = v & 0x3f;
			this.refreshScaling(s.chan);
		} else if (reg >= 0x60 && reg <= 0x75) {
			const s = this.slotAt(bank, reg - 0x60);
			if (!s) return;
			s.ar = v >> 4;
			s.dr = v & 15;
		} else if (reg >= 0x80 && reg <= 0x95) {
			const s = this.slotAt(bank, reg - 0x80);
			if (!s) return;
			s.sl = v >> 4;
			s.rr = v & 15;
		} else if (reg >= 0xe0 && reg <= 0xf5) {
			const s = this.slotAt(bank, reg - 0xe0);
			if (!s) return;
			s.wf = this.opl3 && this.newMode ? v & 7 : this.wse || this.opl3 ? v & 3 : 0;
		} else if (reg >= 0xa0 && reg <= 0xa8) {
			const c = this.channelAt(bank, reg - 0xa0);
			if (!c) return;
			c.fnum = (c.fnum & 0x300) | v;
			this.refreshScaling(c);
		} else if (reg >= 0xb0 && reg <= 0xb8) {
			const c = this.channelAt(bank, reg - 0xb0);
			if (!c) return;
			c.fnum = (c.fnum & 0xff) | ((v & 3) << 8);
			c.block = (v >> 2) & 7;
			this.refreshScaling(c);
			this.setKey(c, (v & 0x20) !== 0);
		} else if (reg === 0xbd && !bank) {
			this.deepAm = (v & 0x80) !== 0;
			this.deepVib = (v & 0x40) !== 0;
			const was = this.rhythm;
			this.rhythm = (v & 0x20) !== 0;
			if (this.rhythm || was) this.setRhythmKeys(v);
		} else if (reg >= 0xc0 && reg <= 0xc8) {
			const c = this.channelAt(bank, reg - 0xc0);
			if (!c) return;
			c.fb = (v >> 1) & 7;
			c.cnt = v & 1;
			if (this.opl3 && this.newMode) {
				c.cha = (v & 0x10) !== 0;
				c.chb = (v & 0x20) !== 0;
			} else c.cha = c.chb = true;
		}
	}

	private slotAt(bank: number, offset: number): Slot | null {
		const i = slotOf(offset);
		if (i < 0) return null;
		return this.slots[i + bank * 18] ?? null;
	}

	private channelAt(bank: number, index: number): Channel | null {
		return this.ch[index + bank * 9] ?? null;
	}

	private updateFourOp(): void {
		for (const c of this.ch) {
			c.four = 0;
			c.pair = null;
		}
		if (!this.opl3 || !this.newMode) return;
		for (let i = 0; i < 6; i++) {
			if (!(this.fourEnable & (1 << i))) continue;
			const first = this.ch[(i < 3 ? 0 : 6) + i];
			const second = this.ch[(i < 3 ? 0 : 6) + i + 3];
			first.four = 1;
			first.pair = second;
			second.four = 2;
			second.pair = first;
		}
	}

	private refreshScaling(c: Channel): void {
		const keycode = (c.block << 1) | ((c.fnum >> (this.nts ? 8 : 9)) & 1);
		const kslBase = Math.max(0, (KSL_ROM[c.fnum >> 6] << 2) - ((8 - c.block) << 5));
		for (const s of c.slots) {
			s.kc = keycode;
			s.ksl = kslBase >> KSL_SHIFT[s.kslIdx];
		}
	}

	private keyOn(s: Slot): void {
		if (s.state === OFF || s.state === RELEASE) {
			s.state = ATTACK;
			s.phase = 0;
		}
	}

	private updateKey(s: Slot): void {
		const key = s.keyChan || s.keyRhythm;
		if (key) this.keyOn(s);
		else if (s.state !== OFF) s.state = RELEASE;
	}

	private setKey(c: Channel, on: boolean): void {
		for (const s of c.slots) {
			s.keyChan = on;
			this.updateKey(s);
		}
		if (c.four === 1 && c.pair) {
			for (const s of c.pair.slots) {
				s.keyChan = on;
				this.updateKey(s);
			}
		}
	}

	private setRhythmKeys(v: number): void {
		const r = this.rhythm;
		const set = (i: number, on: boolean): void => {
			const s = this.slots[i];
			s.keyRhythm = r && on;
			this.updateKey(s);
		};
		set(12, (v & 0x10) !== 0);
		set(15, (v & 0x10) !== 0);
		set(16, (v & 0x08) !== 0);
		set(14, (v & 0x04) !== 0);
		set(17, (v & 0x02) !== 0);
		set(13, (v & 0x01) !== 0);
	}

	/** advance the envelope of a slot by one native sample */
	private envelope(s: Slot): void {
		const ks = s.ksr ? s.kc : s.kc >> 2;
		let rateReg: number;
		switch (s.state) {
			case ATTACK:
				rateReg = s.ar;
				break;
			case DECAY:
				rateReg = s.dr;
				break;
			case SUSTAIN:
				rateReg = s.egt ? 0 : s.rr;
				break;
			case RELEASE:
				rateReg = s.rr;
				break;
			default:
				return;
		}
		const rate = rateReg === 0 ? 0 : Math.min(63, rateReg * 4 + ks);
		if (s.state === ATTACK) {
			if (rate >> 2 >= 15) {
				s.env = 0;
				s.state = DECAY;
				return;
			}
			const inc = egIncrement(rate, this.egCounter, 12);
			if (inc) s.env += (~s.env * inc) >> 3;
			if (s.env <= 0) {
				s.env = 0;
				s.state = DECAY;
			}
			return;
		}
		const inc = egIncrement(rate, this.egCounter, 12);
		s.env = Math.min(511, s.env + inc);
		if (s.state === DECAY) {
			const sl = s.sl === 15 ? 0x1f0 : s.sl << 4;
			if (s.env >= sl) {
				s.env = Math.min(s.env, sl);
				s.state = SUSTAIN;
			}
		} else if (s.env >= 511 && s.state === RELEASE) s.state = OFF;
	}

	/** output of a slot for the phase `p` (10 bit, modulation already added) */
	private wave(s: Slot, p0: number): number {
		const trem = s.am ? this.tremolo : 0;
		const eg = Math.min(511, s.env + (s.tl << 2) + s.ksl + trem);
		let p = p0 & 0x3ff;
		let neg = false;
		let level: number;
		const sine = (q: number): number => LOGSIN[q & 0x100 ? ~q & 0xff : q & 0xff];
		switch (s.wf) {
			case 0:
				neg = (p & 0x200) !== 0;
				level = sine(p);
				break;
			case 1:
				if (p & 0x200) return 0;
				level = sine(p);
				break;
			case 2:
				level = sine(p);
				break;
			case 3:
				if (p & 0x100) return 0;
				level = LOGSIN[p & 0xff];
				break;
			case 4:
				if (p & 0x200) return 0;
				p = (p << 1) & 0x3ff;
				neg = (p & 0x200) !== 0;
				level = sine(p);
				break;
			case 5:
				if (p & 0x200) return 0;
				level = sine((p << 1) & 0x3ff);
				break;
			case 6:
				neg = (p & 0x200) !== 0;
				level = 0;
				break;
			default:
				neg = (p & 0x200) !== 0;
				level = (neg ? ~p & 0x1ff : p & 0x1ff) << 3;
				break;
		}
		const a = expLevel(level + (eg << 3));
		return neg ? -a : a;
	}

	/** compute one slot: `mod` is the phase modulation in 10 bit phase units */
	private runSlot(s: Slot, mod: number, phaseOverride = -1): number {
		const p = phaseOverride >= 0 ? phaseOverride : (s.phase >> 10) & 0x3ff;
		return this.wave(s, p + mod);
	}

	private advancePhase(s: Slot): void {
		const c = s.chan;
		let fnum = c.fnum;
		if (s.vib) {
			let range = (fnum >> 7) & 7;
			const vp = this.vibPos;
			if (!(vp & 3)) range = 0;
			else if (vp & 1) range >>= 1;
			range >>= this.deepVib ? 0 : 1;
			fnum += vp & 4 ? -range : range;
		}
		s.phase = (s.phase + (((fnum << c.block) * s.mul2) >> 1)) & 0xfffff;
	}

	/** native-rate generator used by the resampler: overwrites `n` frames */
	private generate(left: Float32Array, right: Float32Array, n: number): void {
		const scale = 1 / (4084 * 3);
		for (let i = 0; i < n; i++) {
			this.tick();
			let l = 0;
			let r = 0;
			for (const s of this.slots) {
				this.envelope(s);
				this.advancePhase(s);
			}
			const noiseBit = this.noise & 1;
			// rhythm-mode phase network (slots 13 = HH, 16 = SD, 17 = TC)
			let hhPhase = -1;
			let sdPhase = -1;
			let tcPhase = -1;
			if (this.rhythm) {
				const hh = (this.slots[13].phase >> 10) & 0x3ff;
				const tc = (this.slots[17].phase >> 10) & 0x3ff;
				const xor =
					(((hh >> 2) ^ (hh >> 7)) & 1) | (((hh >> 3) ^ (tc >> 5)) & 1) | (((tc >> 2) ^ (tc >> 5)) & 1)
						? 1
						: 0;
				hhPhase = (xor << 9) | (xor ^ noiseBit ? 0xd0 : 0x34);
				sdPhase = (((hh >> 8) & 1) << 9) | ((((hh >> 8) & 1) ^ noiseBit) << 8);
				tcPhase = (xor << 9) | 0x80;
			}
			for (const c of this.ch) {
				if (c.four === 2) continue;
				let sum = 0;
				if (this.rhythm && c.index >= 6 && c.index <= 8) {
					sum = this.rhythmChannel(c, hhPhase, sdPhase, tcPhase);
				} else if (c.four === 1 && c.pair) sum = this.fourOp(c, c.pair);
				else sum = this.twoOp(c);
				if (this.muted[c.index]) continue;
				const v = sum * scale;
				if (c.cha) l += v;
				if (c.chb) r += v;
			}
			left[i] = l;
			right[i] = r;
		}
	}

	private fbMod(s: Slot, fb: number): number {
		return fb ? (s.prout + s.out) >> (9 - fb) : 0;
	}

	private setOut(s: Slot, out: number): void {
		s.prout = s.out;
		s.out = out;
	}

	private twoOp(c: Channel): number {
		const [m, k] = c.slots;
		this.setOut(m, this.runSlot(m, this.fbMod(m, c.fb)));
		if (c.cnt) {
			this.setOut(k, this.runSlot(k, 0));
			return m.out + k.out;
		}
		this.setOut(k, this.runSlot(k, m.out));
		return k.out;
	}

	private fourOp(a: Channel, b: Channel): number {
		const [s0, s1] = a.slots;
		const [s2, s3] = b.slots;
		const alg = a.cnt | (b.cnt << 1);
		this.setOut(s0, this.runSlot(s0, this.fbMod(s0, a.fb)));
		switch (alg) {
			case 0:
				this.setOut(s1, this.runSlot(s1, s0.out));
				this.setOut(s2, this.runSlot(s2, s1.out));
				this.setOut(s3, this.runSlot(s3, s2.out));
				return s3.out;
			case 1:
				this.setOut(s1, this.runSlot(s1, 0));
				this.setOut(s2, this.runSlot(s2, s1.out));
				this.setOut(s3, this.runSlot(s3, s2.out));
				return s0.out + s3.out;
			case 2:
				this.setOut(s1, this.runSlot(s1, s0.out));
				this.setOut(s2, this.runSlot(s2, 0));
				this.setOut(s3, this.runSlot(s3, s2.out));
				return s1.out + s3.out;
			default:
				this.setOut(s1, this.runSlot(s1, 0));
				this.setOut(s2, this.runSlot(s2, s1.out));
				this.setOut(s3, this.runSlot(s3, 0));
				return s0.out + s2.out + s3.out;
		}
	}

	private rhythmChannel(c: Channel, hh: number, sd: number, tc: number): number {
		const [m, k] = c.slots;
		if (c.index === 6) return this.twoOp(c); // bass drum is an ordinary 2-op voice
		if (c.index === 7) {
			this.setOut(m, this.runSlot(m, 0, hh));
			this.setOut(k, this.runSlot(k, 0, sd));
			return (m.out + k.out) * 2;
		}
		this.setOut(m, this.runSlot(m, 0));
		this.setOut(k, this.runSlot(k, 0, tc));
		return (m.out + k.out) * 2;
	}

	/** per-sample LFOs, noise generator and timers */
	private tick(): void {
		this.egCounter = (this.egCounter + 1) & 0xffffffff;
		this.lfoCounter++;
		if ((this.lfoCounter & 63) === 0) {
			const pos = (this.lfoCounter >> 6) % 210;
			let t = (pos < 105 ? pos : 210 - pos) >> 2;
			if (!this.deepAm) t >>= 2;
			this.tremolo = t;
		}
		if ((this.lfoCounter & 1023) === 0) this.vibPos = (this.vibPos + 1) & 7;
		const bit = ((this.noise >> 14) ^ this.noise) & 1;
		this.noise = (this.noise >> 1) | (bit << 22);
		// timers: T1 ticks every 80 us, T2 every 320 us
		if (this.timerCtl & 1 && ++this.t1Count >= (256 - this.t1) * 0.00008 * this.nativeRate) {
			this.t1Count = 0;
			if (!(this.timerCtl & 0x40)) this.status |= 0x40;
		}
		if (this.timerCtl & 2 && ++this.t2Count >= (256 - this.t2) * 0.00032 * this.nativeRate) {
			this.t2Count = 0;
			if (!(this.timerCtl & 0x20)) this.status |= 0x20;
		}
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.resampler.render(left, right, start, count);
	}
}

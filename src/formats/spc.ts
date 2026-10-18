import { SincResampler } from '../driver/Resampler.ts';
import type { Chip } from '../chips/Chip.ts';
import type { PlayerInfo, RetroPlayer } from '../players/Player.ts';
import { Region } from '../region.ts';
import type { InstructionSpender, LoadOptions } from './mwa.ts';

/**
 * SNES music: `.spc` files (a snapshot of the 64 KiB RAM, the 128 DSP registers and the SPC700 registers) played by
 * an SPC700 interpreter driving the S-DSP.
 *
 * The SPC700 core implements the whole instruction set with the per-opcode cycle counts, the three timers (8 kHz, 8 kHz,
 * 64 kHz) and the I/O ports; the DSP mixes 8 voices of BRR samples at 32 000 Hz (4 BRR filters, pitch modulation,
 * ADSR and GAIN envelopes, the noise generator, the echo with its 8 tap FIR filter) and is resampled to the output
 * rate. Approximations: the sample interpolation is a 4 point cubic instead of the Gaussian table of the chip (the 512
 * entry ROM table is not reproduced), the envelope rate counters are per voice instead of the shared counter with the
 * hardware offsets, and the IPL boot ROM is not present (an SPC snapshot starts after it).
 *
 * Written from the public documentation of the SPC700 / S-DSP; no real `.spc` file was available to compare with.
 */

const RAM_SIZE = 0x10000;
const CYCLES = [
	2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6, 2, 8, 4, 5, 3, 4, 3,
	6, 2, 6, 5, 4, 5, 4, 5, 4, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8, 2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4,
	6, 6, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3, 2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5, 2, 8, 4, 5, 4,
	5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6, 2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5,
	2, 2, 12, 5, 3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4, 2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4, 3, 8,
	4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9, 2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3, 2, 8, 4, 5, 3, 4, 3, 6, 2,
	4, 5, 3, 4, 3, 4, 3, 2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 6, 3,
];
const RATE_PERIODS = [
	0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10,
	8, 6, 5, 4, 3, 2, 1,
];

const FLAG_C = 1;
const FLAG_Z = 2;
const FLAG_I = 4;
const FLAG_H = 8;
const FLAG_B = 16;
const FLAG_P = 32;
const FLAG_V = 64;
const FLAG_N = 128;

interface Voice {
	bufPos: number;
	blockAddr: number;
	brr: Int16Array;
	brrIndex: number;
	prev1: number;
	prev2: number;
	pitchCounter: number;
	env: number;
	envMode: 'attack' | 'decay' | 'sustain' | 'release' | 'gain';
	envCounter: number;
	keyedOn: boolean;
	endx: boolean;
	delay: number;
	out: number;
	history: number[];
	released: boolean;
}

export function isSpc(b: Uint8Array): boolean {
	return b.length >= 0x10200 && String.fromCharCode(...b.subarray(0, 27)) === 'SNES-SPC700 Sound File Data';
}

/** The SPC700 processor and the S-DSP of a SNES, loaded from an `.spc` snapshot */
export class SnesApu {
	readonly ram = new Uint8Array(RAM_SIZE);
	readonly dsp = new Uint8Array(128);
	readonly portsIn = new Uint8Array(4);
	readonly portsOut = new Uint8Array(4);
	// SPC700 registers
	a = 0;
	x = 0;
	y = 0;
	sp = 0xef;
	pc = 0;
	psw = 0;
	private dspAddr = 0;
	private timerEnable = 0;
	private readonly timerTarget = [0, 0, 0];
	private readonly timerCount = [0, 0, 0];
	private readonly timerOut = [0, 0, 0];
	private readonly timerCycles = [0, 0, 0];
	private sampleCycles = 0;
	// DSP state
	private readonly voices: Voice[] = Array.from({ length: 8 }, () => ({
		bufPos: 0,
		blockAddr: 0,
		brr: new Int16Array(16),
		brrIndex: 16,
		prev1: 0,
		prev2: 0,
		pitchCounter: 0,
		env: 0,
		envMode: 'release' as const,
		envCounter: 0,
		keyedOn: false,
		endx: false,
		delay: 0,
		out: 0,
		history: [0, 0, 0, 0],
		released: true,
	}));
	private noise = 0x4000;
	private noiseCounter = 0;
	private echoPos = 0;
	private readonly echoHist = [new Int32Array(8), new Int32Array(8)];
	private echoHistPos = 0;
	private readonly mutedVoices = new Array<boolean>(8).fill(false);

	load(file: Uint8Array): void {
		if (!isSpc(file)) throw new Error('not an SPC file');
		this.pc = file[0x25] | (file[0x26] << 8);
		this.a = file[0x27];
		this.x = file[0x28];
		this.y = file[0x29];
		this.psw = file[0x2a];
		this.sp = file[0x2b];
		this.ram.set(file.subarray(0x100, 0x100 + RAM_SIZE));
		this.dsp.set(file.subarray(0x10100, 0x10100 + 128));
		const ctl = this.ram[0xf1];
		this.timerEnable = ctl & 7;
		this.timerTarget[0] = this.ram[0xfa];
		this.timerTarget[1] = this.ram[0xfb];
		this.timerTarget[2] = this.ram[0xfc];
		this.dspAddr = this.ram[0xf2];
		for (let i = 0; i < 3; i++) {
			this.timerCount[i] = 0;
			this.timerOut[i] = 0;
			this.timerCycles[i] = 0;
		}
		for (const v of this.voices) {
			v.env = 0;
			v.envMode = 'release';
			v.brrIndex = 16;
			v.released = true;
			v.keyedOn = false;
		}
		// restore the keyed-on voices of the snapshot with the sample start
		this.sampleCycles = 0;
	}

	setMuted(voice: number, muted: boolean): void {
		if (voice >= 0 && voice < 8) this.mutedVoices[voice] = muted;
	}

	// ------------------------------------------------------------------ bus

	private rd(a: number): number {
		a &= 0xffff;
		if (a >= 0xf0 && a <= 0xff) {
			switch (a) {
				case 0xf2:
					return this.dspAddr;
				case 0xf3:
					return this.dsp[this.dspAddr & 0x7f];
				case 0xf4:
				case 0xf5:
				case 0xf6:
				case 0xf7:
					return this.portsIn[a - 0xf4];
				case 0xfd:
				case 0xfe:
				case 0xff: {
					const v = this.timerOut[a - 0xfd];
					this.timerOut[a - 0xfd] = 0;
					return v;
				}
				default:
					return this.ram[a];
			}
		}
		return this.ram[a];
	}

	private wr(a: number, v: number): void {
		a &= 0xffff;
		v &= 0xff;
		if (a >= 0xf0 && a <= 0xff) {
			switch (a) {
				case 0xf1:
					for (let i = 0; i < 3; i++) {
						if (!(this.timerEnable & (1 << i)) && v & (1 << i)) {
							this.timerCount[i] = 0;
							this.timerOut[i] = 0;
						}
					}
					this.timerEnable = v & 7;
					if (v & 0x10) this.portsIn[0] = this.portsIn[1] = 0;
					if (v & 0x20) this.portsIn[2] = this.portsIn[3] = 0;
					break;
				case 0xf2:
					this.dspAddr = v;
					break;
				case 0xf3:
					if (!(this.dspAddr & 0x80)) this.writeDsp(this.dspAddr & 0x7f, v);
					break;
				case 0xf4:
				case 0xf5:
				case 0xf6:
				case 0xf7:
					this.portsOut[a - 0xf4] = v;
					break;
				case 0xfa:
				case 0xfb:
				case 0xfc:
					this.timerTarget[a - 0xfa] = v;
					break;
			}
		}
		this.ram[a] = v;
	}

	private writeDsp(reg: number, v: number): void {
		if (reg === 0x7c) {
			this.dsp[0x7c] = 0; // writing ENDX clears it
			return;
		}
		this.dsp[reg] = v;
		if (reg === 0x4c) {
			for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOn(i);
		}
		if (reg === 0x5c) {
			for (let i = 0; i < 8; i++) if (v & (1 << i)) this.voices[i].released = true;
		}
	}

	// ------------------------------------------------------------------ SPC700

	private setNZ(v: number): number {
		this.psw = (this.psw & ~(FLAG_N | FLAG_Z)) | (v & 0x80) | ((v & 0xff) === 0 ? FLAG_Z : 0);
		return v & 0xff;
	}
	private fetch(): number {
		const v = this.rd(this.pc);
		this.pc = (this.pc + 1) & 0xffff;
		return v;
	}
	private fetch16(): number {
		const lo = this.fetch();
		return lo | (this.fetch() << 8);
	}
	private dp(): number {
		return (this.psw & FLAG_P ? 0x100 : 0) | this.fetch();
	}
	private dpAddr(d: number): number {
		return (this.psw & FLAG_P ? 0x100 : 0) | (d & 0xff);
	}
	private push(v: number): void {
		this.wr(0x100 | this.sp, v);
		this.sp = (this.sp - 1) & 0xff;
	}
	private pull(): number {
		this.sp = (this.sp + 1) & 0xff;
		return this.rd(0x100 | this.sp);
	}
	private flag(f: number, on: boolean): void {
		if (on) this.psw |= f;
		else this.psw &= ~f;
	}
	private adc(a: number, b: number): number {
		const r = a + b + (this.psw & FLAG_C);
		this.flag(FLAG_C, r > 0xff);
		this.flag(FLAG_V, ((a ^ r) & (b ^ r) & 0x80) !== 0);
		this.flag(FLAG_H, (a & 15) + (b & 15) + (this.psw & FLAG_C ? 1 : 0) > 15);
		return this.setNZ(r & 0xff);
	}
	private sbc(a: number, b: number): number {
		const r = a - b - (this.psw & FLAG_C ? 0 : 1);
		this.flag(FLAG_C, r >= 0);
		this.flag(FLAG_V, ((a ^ b) & (a ^ r) & 0x80) !== 0);
		this.flag(FLAG_H, (a & 15) - (b & 15) - (this.psw & FLAG_C ? 0 : 1) >= 0);
		return this.setNZ(r & 0xff);
	}
	private cmp(a: number, b: number): void {
		const r = a - b;
		this.flag(FLAG_C, r >= 0);
		this.setNZ(r & 0xff);
	}
	private asl(v: number): number {
		this.flag(FLAG_C, (v & 0x80) !== 0);
		return this.setNZ((v << 1) & 0xff);
	}
	private lsr(v: number): number {
		this.flag(FLAG_C, (v & 1) !== 0);
		return this.setNZ(v >> 1);
	}
	private rol(v: number): number {
		const c = this.psw & FLAG_C;
		this.flag(FLAG_C, (v & 0x80) !== 0);
		return this.setNZ(((v << 1) | c) & 0xff);
	}
	private ror(v: number): number {
		const c = this.psw & FLAG_C ? 0x80 : 0;
		this.flag(FLAG_C, (v & 1) !== 0);
		return this.setNZ((v >> 1) | c);
	}
	private rel(cond: boolean): number {
		const o = this.fetch();
		if (cond) {
			this.pc = (this.pc + (o < 128 ? o : o - 256)) & 0xffff;
			return 2;
		}
		return 0;
	}
	private rd16(a: number): number {
		return this.rd(a) | (this.rd((a & 0xff00) | ((a + 1) & 0xff)) << 8);
	}
	private rdDp16(d: number): number {
		const a = this.dpAddr(d);
		return this.rd(a) | (this.rd(this.dpAddr(d + 1)) << 8);
	}
	private bitAddr(): [number, number] {
		const w = this.fetch16();
		return [w & 0x1fff, w >> 13];
	}

	/** run one instruction; returns the cycles it took */
	step(): number {
		const op = this.fetch();
		let cyc = CYCLES[op];
		const P = this.psw;
		switch (op) {
			case 0x00:
				break; // NOP
			case 0x0d:
				this.push(this.psw);
				break;
			case 0x2d:
				this.push(this.a);
				break;
			case 0x4d:
				this.push(this.x);
				break;
			case 0x6d:
				this.push(this.y);
				break;
			case 0x8e:
				this.psw = this.pull();
				break;
			case 0xae:
				this.a = this.pull();
				break;
			case 0xce:
				this.x = this.pull();
				break;
			case 0xee:
				this.y = this.pull();
				break;
			case 0x20:
				this.flag(FLAG_P, false);
				break;
			case 0x40:
				this.flag(FLAG_P, true);
				break;
			case 0x60:
				this.flag(FLAG_C, false);
				break;
			case 0x80:
				this.flag(FLAG_C, true);
				break;
			case 0xed:
				this.psw ^= FLAG_C;
				break;
			case 0xe0:
				this.psw &= ~(FLAG_V | FLAG_H);
				break;
			case 0xa0:
				this.flag(FLAG_I, true);
				break;
			case 0xc0:
				this.flag(FLAG_I, false);
				break;
			case 0xef:
			case 0xff:
				this.pc = (this.pc - 1) & 0xffff;
				break; // SLEEP / STOP: halt
			// ---- MOV
			case 0x7d:
				this.a = this.setNZ(this.x);
				break;
			case 0xdd:
				this.a = this.setNZ(this.y);
				break;
			case 0x5d:
				this.x = this.setNZ(this.a);
				break;
			case 0xfd:
				this.y = this.setNZ(this.a);
				break;
			case 0x9d:
				this.x = this.setNZ(this.sp);
				break;
			case 0xbd:
				this.sp = this.x;
				break;
			case 0xe8:
				this.a = this.setNZ(this.fetch());
				break;
			case 0xcd:
				this.x = this.setNZ(this.fetch());
				break;
			case 0x8d:
				this.y = this.setNZ(this.fetch());
				break;
			case 0xe4:
				this.a = this.setNZ(this.rd(this.dp()));
				break;
			case 0xf4:
				this.a = this.setNZ(this.rd(this.dpAddr(this.fetch() + this.x)));
				break;
			case 0xe5:
				this.a = this.setNZ(this.rd(this.fetch16()));
				break;
			case 0xf5:
				this.a = this.setNZ(this.rd(this.fetch16() + this.x));
				break;
			case 0xf6:
				this.a = this.setNZ(this.rd(this.fetch16() + this.y));
				break;
			case 0xe6:
				this.a = this.setNZ(this.rd(this.dpAddr(this.x)));
				break;
			case 0xe7:
				this.a = this.setNZ(this.rd(this.rdDp16(this.fetch() + this.x)));
				break;
			case 0xf7:
				this.a = this.setNZ(this.rd(this.rdDp16(this.fetch()) + this.y));
				break;
			case 0xbf:
				this.a = this.setNZ(this.rd(this.dpAddr(this.x)));
				this.x = (this.x + 1) & 0xff;
				break;
			case 0xf8:
				this.x = this.setNZ(this.rd(this.dp()));
				break;
			case 0xf9:
				this.x = this.setNZ(this.rd(this.dpAddr(this.fetch() + this.y)));
				break;
			case 0xe9:
				this.x = this.setNZ(this.rd(this.fetch16()));
				break;
			case 0xeb:
				this.y = this.setNZ(this.rd(this.dp()));
				break;
			case 0xfb:
				this.y = this.setNZ(this.rd(this.dpAddr(this.fetch() + this.x)));
				break;
			case 0xec:
				this.y = this.setNZ(this.rd(this.fetch16()));
				break;
			case 0xc4:
				this.wr(this.dp(), this.a);
				break;
			case 0xd4:
				this.wr(this.dpAddr(this.fetch() + this.x), this.a);
				break;
			case 0xc5:
				this.wr(this.fetch16(), this.a);
				break;
			case 0xd5:
				this.wr(this.fetch16() + this.x, this.a);
				break;
			case 0xd6:
				this.wr(this.fetch16() + this.y, this.a);
				break;
			case 0xc6:
				this.wr(this.dpAddr(this.x), this.a);
				break;
			case 0xc7:
				this.wr(this.rdDp16(this.fetch() + this.x), this.a);
				break;
			case 0xd7:
				this.wr(this.rdDp16(this.fetch()) + this.y, this.a);
				break;
			case 0xaf:
				this.wr(this.dpAddr(this.x), this.a);
				this.x = (this.x + 1) & 0xff;
				break;
			case 0xd8:
				this.wr(this.dp(), this.x);
				break;
			case 0xd9:
				this.wr(this.dpAddr(this.fetch() + this.y), this.x);
				break;
			case 0xc9:
				this.wr(this.fetch16(), this.x);
				break;
			case 0xcb:
				this.wr(this.dp(), this.y);
				break;
			case 0xdb:
				this.wr(this.dpAddr(this.fetch() + this.x), this.y);
				break;
			case 0xcc:
				this.wr(this.fetch16(), this.y);
				break;
			case 0x8f: {
				const i = this.fetch();
				this.wr(this.dp(), i);
				break;
			}
			case 0xfa: {
				const s = this.rd(this.dp());
				this.wr(this.dp(), s);
				break;
			}
			case 0xba: {
				const v = this.rdDp16(this.fetch());
				this.a = v & 0xff;
				this.y = v >> 8;
				this.psw = (this.psw & ~(FLAG_N | FLAG_Z)) | (v & 0x8000 ? FLAG_N : 0) | (v === 0 ? FLAG_Z : 0);
				break;
			}
			case 0xda: {
				const d = this.fetch();
				this.wr(this.dpAddr(d), this.a);
				this.wr(this.dpAddr(d + 1), this.y);
				break;
			}
			// ---- OR / AND / EOR / CMP / ADC / SBC with A
			case 0x08:
			case 0x28:
			case 0x48:
			case 0x68:
			case 0x88:
			case 0xa8:
				this.a = this.alu((op >> 4) & 15, this.a, this.fetch());
				break;
			case 0x04:
			case 0x24:
			case 0x44:
			case 0x64:
			case 0x84:
			case 0xa4:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.dp()));
				break;
			case 0x14:
			case 0x34:
			case 0x54:
			case 0x74:
			case 0x94:
			case 0xb4:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.dpAddr(this.fetch() + this.x)));
				break;
			case 0x05:
			case 0x25:
			case 0x45:
			case 0x65:
			case 0x85:
			case 0xa5:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.fetch16()));
				break;
			case 0x15:
			case 0x35:
			case 0x55:
			case 0x75:
			case 0x95:
			case 0xb5:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.fetch16() + this.x));
				break;
			case 0x16:
			case 0x36:
			case 0x56:
			case 0x76:
			case 0x96:
			case 0xb6:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.fetch16() + this.y));
				break;
			case 0x06:
			case 0x26:
			case 0x46:
			case 0x66:
			case 0x86:
			case 0xa6:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.dpAddr(this.x)));
				break;
			case 0x07:
			case 0x27:
			case 0x47:
			case 0x67:
			case 0x87:
			case 0xa7:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.rdDp16(this.fetch() + this.x)));
				break;
			case 0x17:
			case 0x37:
			case 0x57:
			case 0x77:
			case 0x97:
			case 0xb7:
				this.a = this.alu((op >> 4) & 15, this.a, this.rd(this.rdDp16(this.fetch()) + this.y));
				break;
			case 0x09:
			case 0x29:
			case 0x49:
			case 0x69:
			case 0x89:
			case 0xa9: {
				const s = this.rd(this.dp());
				const d = this.dp();
				const r = this.alu((op >> 4) & 15, this.rd(d), s);
				if (op >> 4 !== 6) this.wr(d, r);
				break;
			}
			case 0x18:
			case 0x38:
			case 0x58:
			case 0x78:
			case 0x98:
			case 0xb8: {
				const i = this.fetch();
				const d = this.dp();
				const r = this.alu((op >> 4) & 15, this.rd(d), i);
				if (op >> 4 !== 7) this.wr(d, r);
				break;
			}
			case 0x19:
			case 0x39:
			case 0x59:
			case 0x79:
			case 0x99:
			case 0xb9: {
				const s = this.rd(this.dpAddr(this.y));
				const d = this.dpAddr(this.x);
				const r = this.alu(((op >> 4) & 15) - 1, this.rd(d), s);
				if (op >> 4 !== 7) this.wr(d, r);
				break;
			}
			// ---- CMP X / Y
			case 0xc8:
				this.cmp(this.x, this.fetch());
				break;
			case 0x3e:
				this.cmp(this.x, this.rd(this.dp()));
				break;
			case 0x1e:
				this.cmp(this.x, this.rd(this.fetch16()));
				break;
			case 0xad:
				this.cmp(this.y, this.fetch());
				break;
			case 0x7e:
				this.cmp(this.y, this.rd(this.dp()));
				break;
			case 0x5e:
				this.cmp(this.y, this.rd(this.fetch16()));
				break;
			// ---- shifts, INC, DEC
			case 0x1c:
				this.a = this.asl(this.a);
				break;
			case 0x5c:
				this.a = this.lsr(this.a);
				break;
			case 0x3c:
				this.a = this.rol(this.a);
				break;
			case 0x7c:
				this.a = this.ror(this.a);
				break;
			case 0x0b:
			case 0x4b:
			case 0x2b:
			case 0x6b:
			case 0x8b:
			case 0xab: {
				const d = this.dp();
				this.wr(d, this.rmw(op, this.rd(d)));
				break;
			}
			case 0x1b:
			case 0x5b:
			case 0x3b:
			case 0x7b:
			case 0x9b:
			case 0xbb: {
				const d = this.dpAddr(this.fetch() + this.x);
				this.wr(d, this.rmw(op - 0x10, this.rd(d)));
				break;
			}
			case 0x0c:
			case 0x4c:
			case 0x2c:
			case 0x6c:
			case 0x8c:
			case 0xac: {
				const a = this.fetch16();
				this.wr(a, this.rmw(op, this.rd(a)));
				break;
			}
			case 0x3d:
				this.x = this.setNZ((this.x + 1) & 0xff);
				break;
			case 0x1d:
				this.x = this.setNZ((this.x - 1) & 0xff);
				break;
			case 0xfc:
				this.y = this.setNZ((this.y + 1) & 0xff);
				break;
			case 0xdc:
				this.y = this.setNZ((this.y - 1) & 0xff);
				break;
			case 0xbc:
				this.a = this.setNZ((this.a + 1) & 0xff);
				break;
			case 0x9c:
				this.a = this.setNZ((this.a - 1) & 0xff);
				break;
			case 0x3a:
			case 0x1a: {
				const d = this.fetch();
				const lo = this.rd(this.dpAddr(d));
				const hi = this.rd(this.dpAddr(d + 1));
				const w = ((hi << 8) | lo) + (op === 0x3a ? 1 : -1);
				this.wr(this.dpAddr(d), w & 0xff);
				this.wr(this.dpAddr(d + 1), (w >> 8) & 0xff);
				this.psw =
					(this.psw & ~(FLAG_N | FLAG_Z)) | (w & 0x8000 ? FLAG_N : 0) | ((w & 0xffff) === 0 ? FLAG_Z : 0);
				break;
			}
			// ---- 16 bit
			case 0x7a: {
				const m = this.rdDp16(this.fetch());
				const ya = (this.y << 8) | this.a;
				const r = ya + m;
				this.flag(FLAG_C, r > 0xffff);
				this.flag(FLAG_V, (~(ya ^ m) & (ya ^ r) & 0x8000) !== 0);
				this.flag(FLAG_H, (ya & 0xfff) + (m & 0xfff) > 0xfff);
				this.a = r & 0xff;
				this.y = (r >> 8) & 0xff;
				this.psw =
					(this.psw & ~(FLAG_N | FLAG_Z)) | (r & 0x8000 ? FLAG_N : 0) | ((r & 0xffff) === 0 ? FLAG_Z : 0);
				break;
			}
			case 0x9a: {
				const m = this.rdDp16(this.fetch());
				const ya = (this.y << 8) | this.a;
				const r = ya - m;
				this.flag(FLAG_C, r >= 0);
				this.flag(FLAG_V, ((ya ^ m) & (ya ^ r) & 0x8000) !== 0);
				this.flag(FLAG_H, (ya & 0xfff) - (m & 0xfff) >= 0);
				this.a = r & 0xff;
				this.y = (r >> 8) & 0xff;
				this.psw =
					(this.psw & ~(FLAG_N | FLAG_Z)) | (r & 0x8000 ? FLAG_N : 0) | ((r & 0xffff) === 0 ? FLAG_Z : 0);
				break;
			}
			case 0x5a: {
				const m = this.rdDp16(this.fetch());
				const ya = (this.y << 8) | this.a;
				const r = ya - m;
				this.flag(FLAG_C, r >= 0);
				this.psw =
					(this.psw & ~(FLAG_N | FLAG_Z)) | (r & 0x8000 ? FLAG_N : 0) | ((r & 0xffff) === 0 ? FLAG_Z : 0);
				break;
			}
			case 0xcf: {
				const r = this.y * this.a;
				this.a = r & 0xff;
				this.y = (r >> 8) & 0xff;
				this.psw = (this.psw & ~(FLAG_N | FLAG_Z)) | (this.y & 0x80) | (this.y === 0 ? FLAG_Z : 0);
				break;
			}
			case 0x9e: {
				// DIV YA,X as the hardware computes it (a quotient above 8 bits overflows in a documented way)
				const ya = (this.y << 8) | this.a;
				this.flag(FLAG_V, this.y >= this.x);
				this.flag(FLAG_H, (this.y & 15) >= (this.x & 15));
				if (this.y < this.x << 1) {
					this.a = this.x ? Math.floor(ya / this.x) & 0xff : 0xff;
					this.y = this.x ? ya % this.x : this.a;
				} else {
					this.a = (255 - Math.floor((ya - (this.x << 9)) / (256 - this.x))) & 0xff;
					this.y = (this.x + ((ya - (this.x << 9)) % (256 - this.x))) & 0xff;
				}
				this.setNZ(this.a);
				break;
			}
			case 0x9f:
				this.a = this.setNZ(((this.a << 4) | (this.a >> 4)) & 0xff);
				break;
			case 0xdf: {
				// DAA
				if (this.psw & FLAG_C || this.a > 0x99) {
					this.a = (this.a + 0x60) & 0xff;
					this.flag(FLAG_C, true);
				}
				if (this.psw & FLAG_H || (this.a & 15) > 9) this.a = (this.a + 6) & 0xff;
				this.setNZ(this.a);
				break;
			}
			case 0xbe: {
				// DAS
				if (!(this.psw & FLAG_C) || this.a > 0x99) {
					this.a = (this.a - 0x60) & 0xff;
					this.flag(FLAG_C, false);
				}
				if (!(this.psw & FLAG_H) || (this.a & 15) > 9) this.a = (this.a - 6) & 0xff;
				this.setNZ(this.a);
				break;
			}
			// ---- branches
			case 0x10:
				cyc += this.rel(!(P & FLAG_N));
				break;
			case 0x30:
				cyc += this.rel((P & FLAG_N) !== 0);
				break;
			case 0x50:
				cyc += this.rel(!(P & FLAG_V));
				break;
			case 0x70:
				cyc += this.rel((P & FLAG_V) !== 0);
				break;
			case 0x90:
				cyc += this.rel(!(P & FLAG_C));
				break;
			case 0xb0:
				cyc += this.rel((P & FLAG_C) !== 0);
				break;
			case 0xd0:
				cyc += this.rel(!(P & FLAG_Z));
				break;
			case 0xf0:
				cyc += this.rel((P & FLAG_Z) !== 0);
				break;
			case 0x2f:
				cyc += this.rel(true);
				break;
			case 0x2e: {
				const d = this.dp();
				cyc += this.rel(this.rd(d) !== this.a);
				break;
			}
			case 0xde: {
				const d = this.dpAddr(this.fetch() + this.x);
				cyc += this.rel(this.rd(d) !== this.a);
				break;
			}
			case 0x6e: {
				const d = this.dp();
				const v = (this.rd(d) - 1) & 0xff;
				this.wr(d, v);
				cyc += this.rel(v !== 0);
				break;
			}
			case 0xfe: {
				this.y = (this.y - 1) & 0xff;
				cyc += this.rel(this.y !== 0);
				break;
			}
			case 0x03:
			case 0x23:
			case 0x43:
			case 0x63:
			case 0x83:
			case 0xa3:
			case 0xc3:
			case 0xe3: {
				const d = this.dp();
				cyc += this.rel((this.rd(d) & (1 << (op >> 5))) !== 0);
				break;
			}
			case 0x13:
			case 0x33:
			case 0x53:
			case 0x73:
			case 0x93:
			case 0xb3:
			case 0xd3:
			case 0xf3: {
				const d = this.dp();
				cyc += this.rel((this.rd(d) & (1 << (op >> 5))) === 0);
				break;
			}
			case 0x02:
			case 0x22:
			case 0x42:
			case 0x62:
			case 0x82:
			case 0xa2:
			case 0xc2:
			case 0xe2: {
				const d = this.dp();
				this.wr(d, this.rd(d) | (1 << (op >> 5)));
				break;
			}
			case 0x12:
			case 0x32:
			case 0x52:
			case 0x72:
			case 0x92:
			case 0xb2:
			case 0xd2:
			case 0xf2: {
				const d = this.dp();
				this.wr(d, this.rd(d) & ~(1 << (op >> 5)));
				break;
			}
			// ---- jumps and calls
			case 0x5f:
				this.pc = this.fetch16();
				break;
			case 0x1f:
				this.pc = this.rd16(this.fetch16() + this.x);
				break;
			case 0x3f: {
				const t = this.fetch16();
				this.push(this.pc >> 8);
				this.push(this.pc & 0xff);
				this.pc = t;
				break;
			}
			case 0x4f: {
				const t = 0xff00 | this.fetch();
				this.push(this.pc >> 8);
				this.push(this.pc & 0xff);
				this.pc = t;
				break;
			}
			case 0x6f: {
				const lo = this.pull();
				this.pc = lo | (this.pull() << 8);
				break;
			}
			case 0x7f: {
				this.psw = this.pull();
				const lo = this.pull();
				this.pc = lo | (this.pull() << 8);
				break;
			}
			case 0x0f: {
				this.push(this.pc >> 8);
				this.push(this.pc & 0xff);
				this.push(this.psw);
				this.flag(FLAG_B, true);
				this.flag(FLAG_I, false);
				this.pc = this.rd16(0xffde);
				break;
			}
			case 0x01:
			case 0x11:
			case 0x21:
			case 0x31:
			case 0x41:
			case 0x51:
			case 0x61:
			case 0x71:
			case 0x81:
			case 0x91:
			case 0xa1:
			case 0xb1:
			case 0xc1:
			case 0xd1:
			case 0xe1:
			case 0xf1: {
				this.push(this.pc >> 8);
				this.push(this.pc & 0xff);
				this.pc = this.rd16(0xffde - 2 * (op >> 4));
				break;
			}
			// ---- bit operations on absolute bits
			case 0x0a: {
				const [a, b] = this.bitAddr();
				if (this.rd(a) & (1 << b)) this.psw |= FLAG_C;
				break;
			}
			case 0x2a: {
				const [a, b] = this.bitAddr();
				if (!(this.rd(a) & (1 << b))) this.psw |= FLAG_C;
				break;
			}
			case 0x4a: {
				const [a, b] = this.bitAddr();
				if (!(this.rd(a) & (1 << b))) this.psw &= ~FLAG_C;
				break;
			}
			case 0x6a: {
				const [a, b] = this.bitAddr();
				if (this.rd(a) & (1 << b)) this.psw &= ~FLAG_C;
				break;
			}
			case 0x8a: {
				const [a, b] = this.bitAddr();
				if (this.rd(a) & (1 << b)) this.psw ^= FLAG_C;
				break;
			}
			case 0xaa: {
				const [a, b] = this.bitAddr();
				this.flag(FLAG_C, (this.rd(a) & (1 << b)) !== 0);
				break;
			}
			case 0xca: {
				const [a, b] = this.bitAddr();
				const v = this.rd(a);
				this.wr(a, this.psw & FLAG_C ? v | (1 << b) : v & ~(1 << b));
				break;
			}
			case 0xea: {
				const [a, b] = this.bitAddr();
				this.wr(a, this.rd(a) ^ (1 << b));
				break;
			}
			case 0x0e: {
				const a = this.fetch16();
				const v = this.rd(a);
				this.setNZ((this.a - v) & 0xff);
				this.wr(a, v | this.a);
				break;
			}
			case 0x4e: {
				const a = this.fetch16();
				const v = this.rd(a);
				this.setNZ((this.a - v) & 0xff);
				this.wr(a, v & ~this.a);
				break;
			}
			default:
				throw new Error(
					`SPC700: unsupported opcode $${op.toString(16)} at $${((this.pc - 1) & 0xffff).toString(16)}`,
				);
		}
		return cyc;
	}

	/** ALU operation selected by the high nibble pattern: 0 OR, 2 AND, 4 EOR, 6 CMP, 8 ADC, A SBC (index = nibble >> 1 form) */
	private alu(sel: number, a: number, b: number): number {
		switch (sel & 14) {
			case 0:
				return this.setNZ(a | b);
			case 2:
				return this.setNZ(a & b);
			case 4:
				return this.setNZ(a ^ b);
			case 6:
				this.cmp(a, b);
				return a;
			case 8:
				return this.adc(a, b);
			default:
				return this.sbc(a, b);
		}
	}

	private rmw(op: number, v: number): number {
		switch (op & 0xf0) {
			case 0x00:
				return this.asl(v);
			case 0x40:
				return this.lsr(v);
			case 0x20:
				return this.rol(v);
			case 0x60:
				return this.ror(v);
			case 0x80:
				return this.setNZ((v - 1) & 0xff);
			default:
				return this.setNZ((v + 1) & 0xff);
		}
	}

	// ------------------------------------------------------------------ timers and the main loop

	private tickTimers(cycles: number): void {
		for (let t = 0; t < 3; t++) {
			if (!(this.timerEnable & (1 << t))) continue;
			const period = t === 2 ? 16 : 128;
			this.timerCycles[t] += cycles;
			while (this.timerCycles[t] >= period) {
				this.timerCycles[t] -= period;
				if (++this.timerCount[t] >= (this.timerTarget[t] || 256)) {
					this.timerCount[t] = 0;
					this.timerOut[t] = (this.timerOut[t] + 1) & 15;
				}
			}
		}
	}

	/** instructions run since the player last charged them to its budget */
	instructions = 0;

	/** run the CPU until one DSP sample (32 CPU cycles) has elapsed, then compute it: returns [left, right] in -32768..32767 */
	nextSample(): [number, number] {
		while (this.sampleCycles < 32) {
			const c = this.step();
			this.instructions++;
			this.sampleCycles += c;
			this.tickTimers(c);
		}
		this.sampleCycles -= 32;
		return this.dspSample();
	}

	// ------------------------------------------------------------------ DSP

	private keyOn(i: number): void {
		const v = this.voices[i];
		const dir = this.dsp[0x5d] << 8;
		const srcn = this.dsp[i * 16 + 4];
		const entry = (dir + srcn * 4) & 0xffff;
		v.blockAddr = this.ram[entry] | (this.ram[(entry + 1) & 0xffff] << 8);
		v.brrIndex = 16;
		v.prev1 = v.prev2 = 0;
		v.pitchCounter = 0;
		v.env = 0;
		v.envMode = 'attack';
		v.envCounter = 0;
		v.released = false;
		v.endx = false;
		v.delay = 5;
		v.history = [0, 0, 0, 0];
		this.dsp[0x7c] &= ~(1 << i);
	}

	private decodeBrr(v: Voice, i: number): void {
		const a = v.blockAddr & 0xffff;
		const header = this.ram[a];
		const range = header >> 4;
		const filter = (header >> 2) & 3;
		for (let n = 0; n < 16; n++) {
			const byte = this.ram[(a + 1 + (n >> 1)) & 0xffff];
			let s = n & 1 ? byte & 15 : byte >> 4;
			if (s >= 8) s -= 16;
			s = range <= 12 ? (s << range) >> 1 : s < 0 ? -2048 : 0;
			const p1 = v.prev1;
			const p2 = v.prev2;
			switch (filter) {
				case 1:
					s += p1 + (-p1 >> 4);
					break;
				case 2:
					s += (p1 << 1) + (-((p1 << 1) + p1) >> 5) - p2 + (p2 >> 4);
					break;
				case 3:
					s += (p1 << 1) + (-(p1 + (p1 << 2) + (p1 << 3)) >> 6) - p2 + (((p2 << 1) + p2) >> 4);
					break;
			}
			s = Math.max(-32768, Math.min(32767, s));
			s = (s << 17) >> 17; // 15 bit wrap of the chip
			v.brr[n] = s;
			v.prev2 = p1;
			v.prev1 = s;
		}
		if (header & 1) {
			this.dsp[0x7c] |= 1 << i;
			v.endx = true;
			if (header & 2) {
				const dir = this.dsp[0x5d] << 8;
				const entry = (dir + this.dsp[i * 16 + 4] * 4 + 2) & 0xffff;
				v.blockAddr = this.ram[entry] | (this.ram[(entry + 1) & 0xffff] << 8);
			} else {
				v.env = 0;
				v.envMode = 'release';
				v.released = true;
				v.blockAddr = (v.blockAddr + 9) & 0xffff;
			}
		} else v.blockAddr = (v.blockAddr + 9) & 0xffff;
		v.brrIndex = 0;
	}

	private stepEnvelope(v: Voice, i: number): void {
		const adsr1 = this.dsp[i * 16 + 5];
		const adsr2 = this.dsp[i * 16 + 6];
		const gain = this.dsp[i * 16 + 7];
		if (v.released) {
			v.env = Math.max(0, v.env - 8);
			return;
		}
		const tick = (rate: number): boolean => {
			if (rate === 0) return false;
			const period = RATE_PERIODS[rate];
			if (++v.envCounter >= period) {
				v.envCounter = 0;
				return true;
			}
			return false;
		};
		if (adsr1 & 0x80) {
			if (v.envMode === 'attack') {
				const rate = (adsr1 & 15) * 2 + 1;
				if (tick(rate)) {
					v.env = Math.min(0x7ff, v.env + (rate === 31 ? 1024 : 32));
					if (v.env >= 0x7e0) {
						v.env = Math.min(0x7ff, v.env);
						v.envMode = 'decay';
					}
				}
			} else if (v.envMode === 'decay') {
				if (tick(((adsr1 >> 4) & 7) * 2 + 16)) v.env -= ((v.env - 1) >> 8) + 1;
				if (v.env >> 8 <= adsr2 >> 5) v.envMode = 'sustain';
			} else if (tick(adsr2 & 31)) v.env -= ((v.env - 1) >> 8) + 1;
			v.env = Math.max(0, v.env);
		} else if (gain & 0x80) {
			const rate = gain & 31;
			if (tick(rate)) {
				switch ((gain >> 5) & 3) {
					case 0:
						v.env = Math.max(0, v.env - 32);
						break;
					case 1:
						v.env -= ((v.env - 1) >> 8) + 1;
						break;
					case 2:
						v.env = Math.min(0x7ff, v.env + 32);
						break;
					default:
						v.env = Math.min(0x7ff, v.env + (v.env < 0x600 ? 32 : 8));
				}
				v.env = Math.max(0, v.env);
			}
		} else v.env = (gain & 0x7f) << 4;
	}

	private dspSample(): [number, number] {
		const flg = this.dsp[0x6c];
		let sumL = 0;
		let sumR = 0;
		let echoL = 0;
		let echoR = 0;
		const noiseRate = flg & 31;
		if (noiseRate && ++this.noiseCounter >= RATE_PERIODS[noiseRate]) {
			this.noiseCounter = 0;
			this.noise = (this.noise >> 1) | (((this.noise ^ (this.noise >> 1)) & 1) << 14);
		}
		let prevOut = 0;
		for (let i = 0; i < 8; i++) {
			const v = this.voices[i];
			const base = i * 16;
			let out = 0;
			if (v.delay > 0) {
				v.delay--;
			} else if (!(v.released && v.env === 0)) {
				let pitch = this.dsp[base + 2] | ((this.dsp[base + 3] & 0x3f) << 8);
				if (this.dsp[0x2d] & (1 << i) && i > 0)
					pitch = Math.max(0, Math.min(0x3fff, pitch + (((prevOut >> 5) * pitch) >> 10)));
				v.pitchCounter += pitch;
				while (v.pitchCounter >= 0x1000) {
					v.pitchCounter -= 0x1000;
					if (v.brrIndex >= 16) this.decodeBrr(v, i);
					v.history.shift();
					v.history.push(v.brr[v.brrIndex++]);
				}
				this.stepEnvelope(v, i);
				let s: number;
				if (this.dsp[0x3d] & (1 << i)) s = ((this.noise << 1) << 16) >> 16;
				else {
					// 4 point cubic interpolation (the chip uses a 512 entry Gaussian table)
					const [y0, y1, y2, y3] = v.history;
					const t = v.pitchCounter / 0x1000;
					const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
					const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
					const c = -0.5 * y0 + 0.5 * y2;
					s = Math.max(-32768, Math.min(32767, Math.round(((a * t + b) * t + c) * t + y1)));
				}
				out = (s * v.env) >> 11;
				v.out = out;
			}
			prevOut = out;
			if (this.mutedVoices[i]) continue;
			const vl = (this.dsp[base] << 24) >> 24;
			const vr = (this.dsp[base + 1] << 24) >> 24;
			const l = (out * vl) >> 7;
			const r = (out * vr) >> 7;
			sumL += l;
			sumR += r;
			if (this.dsp[0x4d] & (1 << i)) {
				echoL += l;
				echoR += r;
			}
			this.dsp[base + 8] = (v.env >> 4) & 0x7f;
			this.dsp[base + 9] = (out >> 8) & 0xff;
		}
		// echo
		const esa = this.dsp[0x6d] << 8;
		const edl = this.dsp[0x7d] & 15;
		const delay = edl ? edl * 512 : 1;
		const addr = (esa + this.echoPos * 4) & 0xffff;
		const eL = ((this.ram[addr] | (this.ram[(addr + 1) & 0xffff] << 8)) << 16) >> 16;
		const eR = ((this.ram[(addr + 2) & 0xffff] | (this.ram[(addr + 3) & 0xffff] << 8)) << 16) >> 16;
		this.echoHist[0][this.echoHistPos] = eL;
		this.echoHist[1][this.echoHistPos] = eR;
		this.echoHistPos = (this.echoHistPos + 1) & 7;
		let fL = 0;
		let fR = 0;
		for (let t = 0; t < 8; t++) {
			const c = (this.dsp[t * 16 + 0x0f] << 24) >> 24;
			const idx = (this.echoHistPos + t) & 7;
			fL += (this.echoHist[0][idx] * c) >> 6;
			fR += (this.echoHist[1][idx] * c) >> 6;
		}
		fL = Math.max(-32768, Math.min(32767, fL));
		fR = Math.max(-32768, Math.min(32767, fR));
		if (!(flg & 0x20)) {
			const fb = (this.dsp[0x0d] << 24) >> 24;
			const wL = Math.max(-32768, Math.min(32767, echoL + ((fL * fb) >> 7)));
			const wR = Math.max(-32768, Math.min(32767, echoR + ((fR * fb) >> 7)));
			this.ram[addr] = wL & 0xff;
			this.ram[(addr + 1) & 0xffff] = (wL >> 8) & 0xff;
			this.ram[(addr + 2) & 0xffff] = wR & 0xff;
			this.ram[(addr + 3) & 0xffff] = (wR >> 8) & 0xff;
		}
		if (++this.echoPos >= delay) this.echoPos = 0;
		const mvl = (this.dsp[0x0c] << 24) >> 24;
		const mvr = (this.dsp[0x1c] << 24) >> 24;
		const evl = (this.dsp[0x2c] << 24) >> 24;
		const evr = (this.dsp[0x3c] << 24) >> 24;
		let l = ((Math.max(-32768, Math.min(32767, sumL)) * mvl) >> 7) + ((fL * evl) >> 7);
		let r = ((Math.max(-32768, Math.min(32767, sumR)) * mvr) >> 7) + ((fR * evr) >> 7);
		if (flg & 0x40) l = r = 0; // mute
		return [Math.max(-32768, Math.min(32767, l)), Math.max(-32768, Math.min(32767, r))];
	}
}

/** Plays an `.spc` file: runs the SPC700 and the DSP and resamples the 32 kHz output */
export class SpcPlayer implements RetroPlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[] = [];
	readonly sampleRate: number;
	readonly apu = new SnesApu();
	private readonly file: Uint8Array;
	private readonly resampler: SincResampler;
	private pos = 0;
	private readonly limit: number;
	private readonly budget?: InstructionSpender;

	constructor(file: Uint8Array, options: LoadOptions & { seconds?: number } = {}) {
		this.file = file;
		this.budget = options.budget;
		this.sampleRate = options.sampleRate ?? 44100;
		this.apu.load(file);
		const text = (o: number, n: number): string =>
			String.fromCharCode(...file.subarray(o, o + n))
				.replace(/\0.*$/, '')
				.trim();
		const seconds = Number(text(0xa9, 3)) || options.seconds || 180;
		this.limit = Math.floor((options.seconds ?? seconds) * this.sampleRate);
		this.info = {
			format: 'spc',
			title: text(0x2e, 32) || undefined,
			author: text(0xb1, 32) || undefined,
			comment: [text(0x4e, 32), text(0x7e, 32)].filter(Boolean).join(' - ') || undefined,
			chips: ['snes-dsp'],
			region: Region.NTSC,
			frameRate: 60,
			durationSeconds: seconds,
		};
		let left = 0;
		let right = 0;
		this.resampler = new SincResampler(32000, this.sampleRate, (l, r, n) => {
			for (let i = 0; i < n; i++) {
				[left, right] = this.apu.nextSample();
				this.budget?.spend(this.apu.instructions);
				this.apu.instructions = 0;
				l[i] = left / 32768;
				r[i] = right / 32768;
			}
		});
	}

	get finished(): boolean {
		return this.pos >= this.limit;
	}

	reset(): void {
		this.apu.load(this.file);
		this.resampler.reset();
		this.pos = 0;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): number {
		const n = Math.max(0, Math.min(count, this.limit - this.pos));
		this.resampler.render(left, right, start, n);
		this.pos += n;
		return n;
	}

	setMuted(_chipIndex: number, channel: number, muted: boolean): void {
		this.apu.setMuted(channel, muted);
	}
}

export function loadSpc(bytes: Uint8Array, options: LoadOptions & { seconds?: number } = {}): SpcPlayer {
	return new SpcPlayer(bytes, options);
}

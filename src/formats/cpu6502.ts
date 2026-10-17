/**
 * NMOS 6502 core used to run the music code of NSF and SID files. It implements all documented opcodes with their
 * cycle counts (including page-crossing penalties) and the stable undocumented ones that music players use
 * (LAX, SAX, DCP, ISC, SLO, SRE, RLA, RRA, ANC, ALR, ARR, AXS, the NOP variants). Decimal mode is supported
 * (the NES 2A03 has none: set `decimal = false`). Unknown / unstable opcodes (JAM, XAA, AHX ...) throw.
 */

export interface Bus6502 {
	read(addr: number): number;
	write(addr: number, value: number): void;
}

const C = 1;
const Z = 2;
const I = 4;
const D = 8;
const B = 16;
const U = 32;
const V = 64;
const N = 128;

export class Cpu6502 {
	a = 0;
	x = 0;
	y = 0;
	sp = 0xfd;
	pc = 0;
	p = U | I;
	/** cycles executed since the counter was last cleared */
	cycles = 0;
	/** false on the 2A03 of the NES */
	decimal = true;

	constructor(private readonly bus: Bus6502) {}

	reset(): void {
		this.a = this.x = this.y = 0;
		this.sp = 0xfd;
		this.p = U | I;
		this.pc = this.rd(0xfffc) | (this.rd(0xfffd) << 8);
	}

	private rd(a: number): number {
		return this.bus.read(a & 0xffff) & 0xff;
	}
	private wr(a: number, v: number): void {
		this.bus.write(a & 0xffff, v & 0xff);
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
	/** push a 16 bit return address, high byte first (as the hardware does) */
	push16(v: number): void {
		this.push(v >> 8);
		this.push(v & 255);
	}
	/** push the status register as an interrupt does (B clear, bit 5 set) */
	pushStatus(): void {
		this.push((this.p & ~B) | U);
	}
	private push(v: number): void {
		this.wr(0x100 | this.sp, v);
		this.sp = (this.sp - 1) & 0xff;
	}
	private pull(): number {
		this.sp = (this.sp + 1) & 0xff;
		return this.rd(0x100 | this.sp);
	}
	private nz(v: number): number {
		this.p = (this.p & ~(N | Z)) | (v & 0x80) | (v & 0xff ? 0 : Z);
		return v;
	}
	private flag(f: number, on: boolean): void {
		if (on) this.p |= f;
		else this.p &= ~f;
	}

	/** push a return address and jump (used to call a play / init routine and detect its RTS) */
	jsr(addr: number, returnTo: number): void {
		this.push(((returnTo - 1) >> 8) & 255);
		this.push((returnTo - 1) & 255);
		this.pc = addr;
	}

	irq(vector = 0xfffe): void {
		this.push(this.pc >> 8);
		this.push(this.pc & 255);
		this.push((this.p & ~B) | U);
		this.p |= I;
		this.pc = this.rd(vector) | (this.rd(vector + 1) << 8);
		this.cycles += 7;
	}

	private adc(v: number): void {
		const carry = this.p & C;
		if (this.decimal && this.p & D) {
			let lo = (this.a & 15) + (v & 15) + carry;
			let hi = (this.a >> 4) + (v >> 4);
			const bin = this.a + v + carry;
			this.flag(Z, (bin & 0xff) === 0);
			if (lo > 9) {
				lo += 6;
				hi++;
			}
			this.flag(N, (hi & 8) !== 0);
			this.flag(V, ((this.a ^ v) & 0x80) === 0 && ((this.a ^ (hi << 4)) & 0x80) !== 0);
			if (hi > 9) hi += 6;
			this.flag(C, hi > 15);
			this.a = ((hi << 4) | (lo & 15)) & 0xff;
			return;
		}
		const r = this.a + v + carry;
		this.flag(V, ((this.a ^ r) & (v ^ r) & 0x80) !== 0);
		this.flag(C, r > 0xff);
		this.a = this.nz(r & 0xff);
	}

	private sbc(v: number): void {
		if (this.decimal && this.p & D) {
			const carry = this.p & C ? 0 : 1;
			const bin = this.a - v - carry;
			let lo = (this.a & 15) - (v & 15) - carry;
			let hi = (this.a >> 4) - (v >> 4);
			if (lo < 0) {
				lo -= 6;
				hi--;
			}
			if (hi < 0) hi -= 6;
			this.flag(C, bin >= 0);
			this.flag(V, ((this.a ^ v) & (this.a ^ bin) & 0x80) !== 0);
			this.nz(bin & 0xff);
			this.a = ((hi << 4) | (lo & 15)) & 0xff;
			return;
		}
		this.adc(v ^ 0xff);
	}

	private cmp(r: number, v: number): void {
		const t = r - v;
		this.flag(C, t >= 0);
		this.nz(t & 0xff);
	}

	private asl(v: number): number {
		this.flag(C, (v & 0x80) !== 0);
		return this.nz((v << 1) & 0xff);
	}
	private lsr(v: number): number {
		this.flag(C, (v & 1) !== 0);
		return this.nz(v >> 1);
	}
	private rol(v: number): number {
		const c = this.p & C;
		this.flag(C, (v & 0x80) !== 0);
		return this.nz(((v << 1) | c) & 0xff);
	}
	private ror(v: number): number {
		const c = this.p & C ? 0x80 : 0;
		this.flag(C, (v & 1) !== 0);
		return this.nz((v >> 1) | c);
	}

	private branch(cond: boolean): void {
		const off = this.fetch();
		this.cycles += 2;
		if (cond) {
			const rel = off < 128 ? off : off - 256;
			const to = (this.pc + rel) & 0xffff;
			this.cycles += 1 + ((this.pc & 0xff00) !== (to & 0xff00) ? 1 : 0);
			this.pc = to;
		}
	}

	/** effective address of the addressing modes; `penalty` adds the page-crossing cycle for reads */
	private zp(): number {
		return this.fetch();
	}
	private zpx(): number {
		return (this.fetch() + this.x) & 0xff;
	}
	private zpy(): number {
		return (this.fetch() + this.y) & 0xff;
	}
	private abs(): number {
		return this.fetch16();
	}
	private absx(penalty: boolean): number {
		const base = this.fetch16();
		const a = (base + this.x) & 0xffff;
		if (penalty && (base & 0xff00) !== (a & 0xff00)) this.cycles++;
		return a;
	}
	private absy(penalty: boolean): number {
		const base = this.fetch16();
		const a = (base + this.y) & 0xffff;
		if (penalty && (base & 0xff00) !== (a & 0xff00)) this.cycles++;
		return a;
	}
	private indx(): number {
		const z = (this.fetch() + this.x) & 0xff;
		return this.rd(z) | (this.rd((z + 1) & 0xff) << 8);
	}
	private indy(penalty: boolean): number {
		const z = this.fetch();
		const base = this.rd(z) | (this.rd((z + 1) & 0xff) << 8);
		const a = (base + this.y) & 0xffff;
		if (penalty && (base & 0xff00) !== (a & 0xff00)) this.cycles++;
		return a;
	}

	/** run one instruction; returns its cycle count */
	step(): number {
		const start = this.cycles;
		const op = this.fetch();
		switch (op) {
			// ---- loads / stores
			case 0xa9:
				this.a = this.nz(this.fetch());
				this.cycles += 2;
				break;
			case 0xa5:
				this.a = this.nz(this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0xb5:
				this.a = this.nz(this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0xad:
				this.a = this.nz(this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0xbd:
				this.a = this.nz(this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0xb9:
				this.a = this.nz(this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0xa1:
				this.a = this.nz(this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0xb1:
				this.a = this.nz(this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0xa2:
				this.x = this.nz(this.fetch());
				this.cycles += 2;
				break;
			case 0xa6:
				this.x = this.nz(this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0xb6:
				this.x = this.nz(this.rd(this.zpy()));
				this.cycles += 4;
				break;
			case 0xae:
				this.x = this.nz(this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0xbe:
				this.x = this.nz(this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0xa0:
				this.y = this.nz(this.fetch());
				this.cycles += 2;
				break;
			case 0xa4:
				this.y = this.nz(this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0xb4:
				this.y = this.nz(this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0xac:
				this.y = this.nz(this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0xbc:
				this.y = this.nz(this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0x85:
				this.wr(this.zp(), this.a);
				this.cycles += 3;
				break;
			case 0x95:
				this.wr(this.zpx(), this.a);
				this.cycles += 4;
				break;
			case 0x8d:
				this.wr(this.abs(), this.a);
				this.cycles += 4;
				break;
			case 0x9d:
				this.wr(this.absx(false), this.a);
				this.cycles += 5;
				break;
			case 0x99:
				this.wr(this.absy(false), this.a);
				this.cycles += 5;
				break;
			case 0x81:
				this.wr(this.indx(), this.a);
				this.cycles += 6;
				break;
			case 0x91:
				this.wr(this.indy(false), this.a);
				this.cycles += 6;
				break;
			case 0x86:
				this.wr(this.zp(), this.x);
				this.cycles += 3;
				break;
			case 0x96:
				this.wr(this.zpy(), this.x);
				this.cycles += 4;
				break;
			case 0x8e:
				this.wr(this.abs(), this.x);
				this.cycles += 4;
				break;
			case 0x84:
				this.wr(this.zp(), this.y);
				this.cycles += 3;
				break;
			case 0x94:
				this.wr(this.zpx(), this.y);
				this.cycles += 4;
				break;
			case 0x8c:
				this.wr(this.abs(), this.y);
				this.cycles += 4;
				break;
			// ---- transfers / stack
			case 0xaa:
				this.x = this.nz(this.a);
				this.cycles += 2;
				break;
			case 0xa8:
				this.y = this.nz(this.a);
				this.cycles += 2;
				break;
			case 0x8a:
				this.a = this.nz(this.x);
				this.cycles += 2;
				break;
			case 0x98:
				this.a = this.nz(this.y);
				this.cycles += 2;
				break;
			case 0xba:
				this.x = this.nz(this.sp);
				this.cycles += 2;
				break;
			case 0x9a:
				this.sp = this.x;
				this.cycles += 2;
				break;
			case 0x48:
				this.push(this.a);
				this.cycles += 3;
				break;
			case 0x08:
				this.push(this.p | B | U);
				this.cycles += 3;
				break;
			case 0x68:
				this.a = this.nz(this.pull());
				this.cycles += 4;
				break;
			case 0x28:
				this.p = (this.pull() & ~B) | U;
				this.cycles += 4;
				break;
			// ---- logic
			case 0x29:
				this.a = this.nz(this.a & this.fetch());
				this.cycles += 2;
				break;
			case 0x25:
				this.a = this.nz(this.a & this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0x35:
				this.a = this.nz(this.a & this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0x2d:
				this.a = this.nz(this.a & this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0x3d:
				this.a = this.nz(this.a & this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0x39:
				this.a = this.nz(this.a & this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0x21:
				this.a = this.nz(this.a & this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0x31:
				this.a = this.nz(this.a & this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0x09:
				this.a = this.nz(this.a | this.fetch());
				this.cycles += 2;
				break;
			case 0x05:
				this.a = this.nz(this.a | this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0x15:
				this.a = this.nz(this.a | this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0x0d:
				this.a = this.nz(this.a | this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0x1d:
				this.a = this.nz(this.a | this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0x19:
				this.a = this.nz(this.a | this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0x01:
				this.a = this.nz(this.a | this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0x11:
				this.a = this.nz(this.a | this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0x49:
				this.a = this.nz(this.a ^ this.fetch());
				this.cycles += 2;
				break;
			case 0x45:
				this.a = this.nz(this.a ^ this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0x55:
				this.a = this.nz(this.a ^ this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0x4d:
				this.a = this.nz(this.a ^ this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0x5d:
				this.a = this.nz(this.a ^ this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0x59:
				this.a = this.nz(this.a ^ this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0x41:
				this.a = this.nz(this.a ^ this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0x51:
				this.a = this.nz(this.a ^ this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0x24:
				this.bit(this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0x2c:
				this.bit(this.rd(this.abs()));
				this.cycles += 4;
				break;
			// ---- arithmetic
			case 0x69:
				this.adc(this.fetch());
				this.cycles += 2;
				break;
			case 0x65:
				this.adc(this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0x75:
				this.adc(this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0x6d:
				this.adc(this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0x7d:
				this.adc(this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0x79:
				this.adc(this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0x61:
				this.adc(this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0x71:
				this.adc(this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0xe9:
			case 0xeb:
				this.sbc(this.fetch());
				this.cycles += 2;
				break;
			case 0xe5:
				this.sbc(this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0xf5:
				this.sbc(this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0xed:
				this.sbc(this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0xfd:
				this.sbc(this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0xf9:
				this.sbc(this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0xe1:
				this.sbc(this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0xf1:
				this.sbc(this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0xc9:
				this.cmp(this.a, this.fetch());
				this.cycles += 2;
				break;
			case 0xc5:
				this.cmp(this.a, this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0xd5:
				this.cmp(this.a, this.rd(this.zpx()));
				this.cycles += 4;
				break;
			case 0xcd:
				this.cmp(this.a, this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0xdd:
				this.cmp(this.a, this.rd(this.absx(true)));
				this.cycles += 4;
				break;
			case 0xd9:
				this.cmp(this.a, this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0xc1:
				this.cmp(this.a, this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0xd1:
				this.cmp(this.a, this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0xe0:
				this.cmp(this.x, this.fetch());
				this.cycles += 2;
				break;
			case 0xe4:
				this.cmp(this.x, this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0xec:
				this.cmp(this.x, this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0xc0:
				this.cmp(this.y, this.fetch());
				this.cycles += 2;
				break;
			case 0xc4:
				this.cmp(this.y, this.rd(this.zp()));
				this.cycles += 3;
				break;
			case 0xcc:
				this.cmp(this.y, this.rd(this.abs()));
				this.cycles += 4;
				break;
			// ---- inc / dec
			case 0xe6:
				this.rmw(this.zp(), (v) => this.nz((v + 1) & 0xff), 5);
				break;
			case 0xf6:
				this.rmw(this.zpx(), (v) => this.nz((v + 1) & 0xff), 6);
				break;
			case 0xee:
				this.rmw(this.abs(), (v) => this.nz((v + 1) & 0xff), 6);
				break;
			case 0xfe:
				this.rmw(this.absx(false), (v) => this.nz((v + 1) & 0xff), 7);
				break;
			case 0xc6:
				this.rmw(this.zp(), (v) => this.nz((v - 1) & 0xff), 5);
				break;
			case 0xd6:
				this.rmw(this.zpx(), (v) => this.nz((v - 1) & 0xff), 6);
				break;
			case 0xce:
				this.rmw(this.abs(), (v) => this.nz((v - 1) & 0xff), 6);
				break;
			case 0xde:
				this.rmw(this.absx(false), (v) => this.nz((v - 1) & 0xff), 7);
				break;
			case 0xe8:
				this.x = this.nz((this.x + 1) & 0xff);
				this.cycles += 2;
				break;
			case 0xc8:
				this.y = this.nz((this.y + 1) & 0xff);
				this.cycles += 2;
				break;
			case 0xca:
				this.x = this.nz((this.x - 1) & 0xff);
				this.cycles += 2;
				break;
			case 0x88:
				this.y = this.nz((this.y - 1) & 0xff);
				this.cycles += 2;
				break;
			// ---- shifts
			case 0x0a:
				this.a = this.asl(this.a);
				this.cycles += 2;
				break;
			case 0x06:
				this.rmw(this.zp(), (v) => this.asl(v), 5);
				break;
			case 0x16:
				this.rmw(this.zpx(), (v) => this.asl(v), 6);
				break;
			case 0x0e:
				this.rmw(this.abs(), (v) => this.asl(v), 6);
				break;
			case 0x1e:
				this.rmw(this.absx(false), (v) => this.asl(v), 7);
				break;
			case 0x4a:
				this.a = this.lsr(this.a);
				this.cycles += 2;
				break;
			case 0x46:
				this.rmw(this.zp(), (v) => this.lsr(v), 5);
				break;
			case 0x56:
				this.rmw(this.zpx(), (v) => this.lsr(v), 6);
				break;
			case 0x4e:
				this.rmw(this.abs(), (v) => this.lsr(v), 6);
				break;
			case 0x5e:
				this.rmw(this.absx(false), (v) => this.lsr(v), 7);
				break;
			case 0x2a:
				this.a = this.rol(this.a);
				this.cycles += 2;
				break;
			case 0x26:
				this.rmw(this.zp(), (v) => this.rol(v), 5);
				break;
			case 0x36:
				this.rmw(this.zpx(), (v) => this.rol(v), 6);
				break;
			case 0x2e:
				this.rmw(this.abs(), (v) => this.rol(v), 6);
				break;
			case 0x3e:
				this.rmw(this.absx(false), (v) => this.rol(v), 7);
				break;
			case 0x6a:
				this.a = this.ror(this.a);
				this.cycles += 2;
				break;
			case 0x66:
				this.rmw(this.zp(), (v) => this.ror(v), 5);
				break;
			case 0x76:
				this.rmw(this.zpx(), (v) => this.ror(v), 6);
				break;
			case 0x6e:
				this.rmw(this.abs(), (v) => this.ror(v), 6);
				break;
			case 0x7e:
				this.rmw(this.absx(false), (v) => this.ror(v), 7);
				break;
			// ---- jumps / branches
			case 0x4c:
				this.pc = this.abs();
				this.cycles += 3;
				break;
			case 0x6c: {
				const p = this.fetch16();
				// the NMOS page-wrap bug of indirect JMP
				this.pc = this.rd(p) | (this.rd((p & 0xff00) | ((p + 1) & 0xff)) << 8);
				this.cycles += 5;
				break;
			}
			case 0x20: {
				const t = this.fetch16();
				const ret = (this.pc - 1) & 0xffff;
				this.push(ret >> 8);
				this.push(ret & 255);
				this.pc = t;
				this.cycles += 6;
				break;
			}
			case 0x60: {
				const lo = this.pull();
				this.pc = (lo | (this.pull() << 8)) + 1;
				this.pc &= 0xffff;
				this.cycles += 6;
				break;
			}
			case 0x40: {
				this.p = (this.pull() & ~B) | U;
				const lo = this.pull();
				this.pc = lo | (this.pull() << 8);
				this.cycles += 6;
				break;
			}
			case 0x00: {
				this.fetch();
				this.push(this.pc >> 8);
				this.push(this.pc & 255);
				this.push(this.p | B | U);
				this.p |= I;
				this.pc = this.rd(0xfffe) | (this.rd(0xffff) << 8);
				this.cycles += 7;
				break;
			}
			case 0x10:
				this.branch(!(this.p & N));
				break;
			case 0x30:
				this.branch((this.p & N) !== 0);
				break;
			case 0x50:
				this.branch(!(this.p & V));
				break;
			case 0x70:
				this.branch((this.p & V) !== 0);
				break;
			case 0x90:
				this.branch(!(this.p & C));
				break;
			case 0xb0:
				this.branch((this.p & C) !== 0);
				break;
			case 0xd0:
				this.branch(!(this.p & Z));
				break;
			case 0xf0:
				this.branch((this.p & Z) !== 0);
				break;
			// ---- flags
			case 0x18:
				this.p &= ~C;
				this.cycles += 2;
				break;
			case 0x38:
				this.p |= C;
				this.cycles += 2;
				break;
			case 0x58:
				this.p &= ~I;
				this.cycles += 2;
				break;
			case 0x78:
				this.p |= I;
				this.cycles += 2;
				break;
			case 0xb8:
				this.p &= ~V;
				this.cycles += 2;
				break;
			case 0xd8:
				this.p &= ~D;
				this.cycles += 2;
				break;
			case 0xf8:
				this.p |= D;
				this.cycles += 2;
				break;
			case 0xea:
				this.cycles += 2;
				break;
			// ---- undocumented, stable
			case 0xa7:
				this.a = this.x = this.nz(this.rd(this.zp()));
				this.cycles += 3;
				break; // LAX
			case 0xb7:
				this.a = this.x = this.nz(this.rd(this.zpy()));
				this.cycles += 4;
				break;
			case 0xaf:
				this.a = this.x = this.nz(this.rd(this.abs()));
				this.cycles += 4;
				break;
			case 0xbf:
				this.a = this.x = this.nz(this.rd(this.absy(true)));
				this.cycles += 4;
				break;
			case 0xa3:
				this.a = this.x = this.nz(this.rd(this.indx()));
				this.cycles += 6;
				break;
			case 0xb3:
				this.a = this.x = this.nz(this.rd(this.indy(true)));
				this.cycles += 5;
				break;
			case 0x87:
				this.wr(this.zp(), this.a & this.x);
				this.cycles += 3;
				break; // SAX
			case 0x97:
				this.wr(this.zpy(), this.a & this.x);
				this.cycles += 4;
				break;
			case 0x8f:
				this.wr(this.abs(), this.a & this.x);
				this.cycles += 4;
				break;
			case 0x83:
				this.wr(this.indx(), this.a & this.x);
				this.cycles += 6;
				break;
			case 0xc7:
				this.rmw(this.zp(), (v) => this.dcp(v), 5);
				break;
			case 0xd7:
				this.rmw(this.zpx(), (v) => this.dcp(v), 6);
				break;
			case 0xcf:
				this.rmw(this.abs(), (v) => this.dcp(v), 6);
				break;
			case 0xdf:
				this.rmw(this.absx(false), (v) => this.dcp(v), 7);
				break;
			case 0xdb:
				this.rmw(this.absy(false), (v) => this.dcp(v), 7);
				break;
			case 0xc3:
				this.rmw(this.indx(), (v) => this.dcp(v), 8);
				break;
			case 0xd3:
				this.rmw(this.indy(false), (v) => this.dcp(v), 8);
				break;
			case 0xe7:
				this.rmw(this.zp(), (v) => this.isc(v), 5);
				break;
			case 0xf7:
				this.rmw(this.zpx(), (v) => this.isc(v), 6);
				break;
			case 0xef:
				this.rmw(this.abs(), (v) => this.isc(v), 6);
				break;
			case 0xff:
				this.rmw(this.absx(false), (v) => this.isc(v), 7);
				break;
			case 0xfb:
				this.rmw(this.absy(false), (v) => this.isc(v), 7);
				break;
			case 0xe3:
				this.rmw(this.indx(), (v) => this.isc(v), 8);
				break;
			case 0xf3:
				this.rmw(this.indy(false), (v) => this.isc(v), 8);
				break;
			case 0x07:
				this.rmw(this.zp(), (v) => this.slo(v), 5);
				break;
			case 0x17:
				this.rmw(this.zpx(), (v) => this.slo(v), 6);
				break;
			case 0x0f:
				this.rmw(this.abs(), (v) => this.slo(v), 6);
				break;
			case 0x1f:
				this.rmw(this.absx(false), (v) => this.slo(v), 7);
				break;
			case 0x1b:
				this.rmw(this.absy(false), (v) => this.slo(v), 7);
				break;
			case 0x03:
				this.rmw(this.indx(), (v) => this.slo(v), 8);
				break;
			case 0x13:
				this.rmw(this.indy(false), (v) => this.slo(v), 8);
				break;
			case 0x47:
				this.rmw(this.zp(), (v) => this.sre(v), 5);
				break;
			case 0x57:
				this.rmw(this.zpx(), (v) => this.sre(v), 6);
				break;
			case 0x4f:
				this.rmw(this.abs(), (v) => this.sre(v), 6);
				break;
			case 0x5f:
				this.rmw(this.absx(false), (v) => this.sre(v), 7);
				break;
			case 0x5b:
				this.rmw(this.absy(false), (v) => this.sre(v), 7);
				break;
			case 0x43:
				this.rmw(this.indx(), (v) => this.sre(v), 8);
				break;
			case 0x53:
				this.rmw(this.indy(false), (v) => this.sre(v), 8);
				break;
			case 0x27:
				this.rmw(this.zp(), (v) => this.rla(v), 5);
				break;
			case 0x37:
				this.rmw(this.zpx(), (v) => this.rla(v), 6);
				break;
			case 0x2f:
				this.rmw(this.abs(), (v) => this.rla(v), 6);
				break;
			case 0x3f:
				this.rmw(this.absx(false), (v) => this.rla(v), 7);
				break;
			case 0x3b:
				this.rmw(this.absy(false), (v) => this.rla(v), 7);
				break;
			case 0x23:
				this.rmw(this.indx(), (v) => this.rla(v), 8);
				break;
			case 0x33:
				this.rmw(this.indy(false), (v) => this.rla(v), 8);
				break;
			case 0x67:
				this.rmw(this.zp(), (v) => this.rra(v), 5);
				break;
			case 0x77:
				this.rmw(this.zpx(), (v) => this.rra(v), 6);
				break;
			case 0x6f:
				this.rmw(this.abs(), (v) => this.rra(v), 6);
				break;
			case 0x7f:
				this.rmw(this.absx(false), (v) => this.rra(v), 7);
				break;
			case 0x7b:
				this.rmw(this.absy(false), (v) => this.rra(v), 7);
				break;
			case 0x63:
				this.rmw(this.indx(), (v) => this.rra(v), 8);
				break;
			case 0x73:
				this.rmw(this.indy(false), (v) => this.rra(v), 8);
				break;
			case 0x0b:
			case 0x2b:
				this.a = this.nz(this.a & this.fetch());
				this.flag(C, (this.a & 0x80) !== 0);
				this.cycles += 2;
				break; // ANC
			case 0x4b:
				this.a = this.lsr(this.a & this.fetch());
				this.cycles += 2;
				break; // ALR
			case 0x6b: {
				// ARR
				this.a = this.nz((((this.a & this.fetch()) >> 1) | (this.p & C ? 0x80 : 0)) & 0xff);
				this.flag(C, (this.a & 0x40) !== 0);
				this.flag(V, ((this.a >> 6) ^ (this.a >> 5)) & 1 ? true : false);
				this.cycles += 2;
				break;
			}
			case 0xcb: {
				// AXS
				const t = (this.a & this.x) - this.fetch();
				this.flag(C, t >= 0);
				this.x = this.nz(t & 0xff);
				this.cycles += 2;
				break;
			}
			// NOP variants
			case 0x1a:
			case 0x3a:
			case 0x5a:
			case 0x7a:
			case 0xda:
			case 0xfa:
				this.cycles += 2;
				break;
			case 0x80:
			case 0x82:
			case 0x89:
			case 0xc2:
			case 0xe2:
				this.fetch();
				this.cycles += 2;
				break;
			case 0x04:
			case 0x44:
			case 0x64:
				this.fetch();
				this.cycles += 3;
				break;
			case 0x14:
			case 0x34:
			case 0x54:
			case 0x74:
			case 0xd4:
			case 0xf4:
				this.fetch();
				this.cycles += 4;
				break;
			case 0x0c:
				this.fetch16();
				this.cycles += 4;
				break;
			case 0x1c:
			case 0x3c:
			case 0x5c:
			case 0x7c:
			case 0xdc:
			case 0xfc:
				this.absx(true);
				this.cycles += 4;
				break;
			default:
				throw new Error(
					`6502: unsupported opcode $${op.toString(16).padStart(2, '0')} at $${((this.pc - 1) & 0xffff).toString(16)}`,
				);
		}
		return this.cycles - start;
	}

	private bit(v: number): void {
		this.flag(Z, (this.a & v) === 0);
		this.p = (this.p & ~(N | V)) | (v & (N | V));
	}

	private rmw(addr: number, f: (v: number) => number, cycles: number): void {
		const v = this.rd(addr);
		this.wr(addr, v); // the real chip writes the old value back first
		this.wr(addr, f(v) & 0xff);
		this.cycles += cycles;
	}
	private dcp(v: number): number {
		const r = (v - 1) & 0xff;
		this.cmp(this.a, r);
		return r;
	}
	private isc(v: number): number {
		const r = (v + 1) & 0xff;
		this.sbc(r);
		return r;
	}
	private slo(v: number): number {
		const r = this.asl(v);
		this.a = this.nz(this.a | r);
		return r;
	}
	private sre(v: number): number {
		const r = this.lsr(v);
		this.a = this.nz(this.a ^ r);
		return r;
	}
	private rla(v: number): number {
		const r = this.rol(v);
		this.a = this.nz(this.a & r);
		return r;
	}
	private rra(v: number): number {
		const r = this.ror(v);
		this.adc(r);
		return r;
	}
}

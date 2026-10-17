import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cpu6502 } from '../src/formats/cpu6502.ts';

function run(
	program: number[],
	setup?: (cpu: Cpu6502, mem: Uint8Array) => void,
	maxSteps = 10000,
): { cpu: Cpu6502; mem: Uint8Array } {
	const mem = new Uint8Array(65536);
	mem.set(program, 0x0600);
	const cpu = new Cpu6502({ read: (a) => mem[a], write: (a, v) => void (mem[a] = v) });
	cpu.pc = 0x0600;
	setup?.(cpu, mem);
	for (let i = 0; i < maxSteps && mem[cpu.pc] !== 0x02; i++) cpu.step(); // 0x02 (JAM) marks the end
	return { cpu, mem };
}

test('loads, stores, transfers and flags', () => {
	const { cpu, mem } = run([0xa9, 0x80, 0x85, 0x10, 0xaa, 0xe8, 0x8e, 0x11, 0x00, 0x02]);
	assert.equal(mem[0x10], 0x80);
	assert.equal(mem[0x11], 0x81);
	assert.equal(cpu.x, 0x81);
	assert.ok(cpu.p & 0x80, 'negative flag');
});

test('a counting loop with a branch takes the documented number of cycles', () => {
	// LDX #5 ; loop: DEX ; BNE loop ; JAM
	const { cpu } = run([0xa2, 0x05, 0xca, 0xd0, 0xfd, 0x02]);
	assert.equal(cpu.x, 0);
	// LDX 2 + 5 * DEX 2 + 4 taken branches (3) + 1 not taken (2) = 2 + 10 + 12 + 2
	assert.equal(cpu.cycles, 26);
});

test('JSR / RTS and the stack', () => {
	const { cpu, mem } = run([0x20, 0x08, 0x06, 0xa9, 0x07, 0x85, 0x20, 0x02, 0xa9, 0x42, 0x60]);
	assert.equal(mem[0x20], 0x07);
	assert.equal(cpu.a, 0x07);
	assert.equal(cpu.sp, 0xfd);
});

test('binary and decimal addition, carry and overflow', () => {
	const bin = run([0x18, 0xa9, 0x50, 0x69, 0x50, 0x02]);
	assert.equal(bin.cpu.a, 0xa0);
	assert.ok(bin.cpu.p & 0x40, 'overflow: 80 + 80 as signed');
	const dec = run([0xf8, 0x18, 0xa9, 0x19, 0x69, 0x28, 0x02]);
	assert.equal(dec.cpu.a, 0x47, 'BCD 19 + 28 = 47');
	const nes = run([0xf8, 0x18, 0xa9, 0x19, 0x69, 0x28, 0x02], (cpu) => (cpu.decimal = false));
	assert.equal(nes.cpu.a, 0x41, 'the 2A03 ignores the decimal flag');
});

test('indirect JMP has the page wrap bug of the NMOS chip', () => {
	const { cpu } = run([0x6c, 0xff, 0x10, 0x02], (_c, mem) => {
		mem[0x10ff] = 0x34;
		mem[0x1000] = 0x06; // the high byte comes from the start of the same page, not 0x1100
		mem[0x1100] = 0x99;
		mem[0x0634] = 0x02;
	});
	assert.equal(cpu.pc, 0x0634);
});

test('undocumented opcodes used by music players: LAX, SAX, DCP, SLO', () => {
	const { cpu, mem } = run([0xa7, 0x30, 0x87, 0x31, 0xc7, 0x32, 0x07, 0x33, 0x02], (_c, m) => {
		m[0x30] = 0x5a;
		m[0x32] = 0x10;
		m[0x33] = 0x81;
	});
	assert.equal(cpu.x, 0x5a);
	assert.equal(mem[0x31], 0x5a & 0x5a);
	assert.equal(mem[0x32], 0x0f);
	assert.equal(mem[0x33], 0x02);
	assert.throws(() => run([0xb2, 0x00, 0x02]), /unsupported opcode/);
});

test('interrupt entry pushes the return address and status; RTI returns', () => {
	const { cpu } = run([0x58, 0x00, 0x02, 0xea, 0xea, 0x02], (_c, mem) => {
		mem[0xfffe] = 0x00;
		mem[0xffff] = 0x07;
		mem[0x0700] = 0x40; // RTI
	});
	assert.equal(cpu.pc, 0x0605, 'BRK returns two bytes after itself, past the padding byte, and the NOPs run');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnesApu, SpcPlayer, isSpc } from '../src/formats/spc.ts';
import { detectFormat } from '../src/formats/index.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { frequency, peak, RATE } from './util.ts';

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** an SPC snapshot: 64 KiB RAM with `program` at $0400 and the given DSP registers */
function buildSpc(ram: (r: Uint8Array) => void, dsp: Record<number, number> = {}, pc = 0x0400): Uint8Array {
	const f = new Uint8Array(0x10200);
	f.set(ascii('SNES-SPC700 Sound File Data v0.30'));
	f[0x21] = 26;
	f[0x22] = 26;
	f[0x23] = 26;
	f[0x24] = 30;
	f[0x25] = pc & 255;
	f[0x26] = pc >> 8;
	f[0x2b] = 0xef;
	f.set(ascii('Test tune'), 0x2e);
	f.set(ascii('5'), 0xa9);
	ram(f.subarray(0x100, 0x100 + 0x10000));
	for (const [r, v] of Object.entries(dsp)) f[0x10100 + Number(r)] = v;
	return f;
}

/** a BRR block: range 12, filter 0, loop + end; 16 nibbles = 8 high (+7) then 8 low (-7): a square cycle */
const SQUARE_BRR = [0xc3, 0x77, 0x77, 0x77, 0x77, 0x99, 0x99, 0x99, 0x99];

function dspProgram(regs: [number, number][]): number[] {
	const code: number[] = [];
	for (const [r, v] of regs) code.push(0x8f, r, 0xf2, 0x8f, v, 0xf3);
	code.push(0x2f, 0xfe); // BRA to itself
	return code;
}

test('SPC700 instructions: arithmetic with flags, 16 bit operations, branches and the stack', () => {
	const apu = new SnesApu();
	const run = (code: number[], steps: number): void => {
		apu.ram.fill(0);
		apu.ram.set(code, 0x0400);
		apu.pc = 0x0400;
		apu.psw = 0;
		apu.sp = 0xef;
		for (let i = 0; i < steps; i++) apu.step();
	};
	run([0xe8, 0x7f, 0x88, 0x01], 2); // MOV A,#$7F ; ADC A,#1
	assert.equal(apu.a, 0x80);
	assert.ok(apu.psw & 64 && apu.psw & 128, 'overflow and negative');
	run([0x80, 0xe8, 0x10, 0xa8, 0x01], 3); // SETC ; MOV A,#$10 ; SBC A,#1  -> $0F
	assert.equal(apu.a, 0x0f);
	run([0x8d, 0x03, 0xe8, 0x0a, 0xcf], 3); // MOV Y,#3 ; MOV A,#10 ; MUL YA -> 30
	assert.equal((apu.y << 8) | apu.a, 30);
	run([0xe8, 0x07, 0x8d, 0x00, 0xcd, 0x03, 0x9e], 4); // DIV YA,X : 7 / 3
	assert.equal(apu.a, 2);
	assert.equal(apu.y, 1);
	run([0xe8, 0x12, 0x2d, 0xe8, 0x00, 0xae], 4); // push A, load 0, pop A
	assert.equal(apu.a, 0x12);
	run([0xcd, 0x03, 0xe8, 0x00, 0xbc, 0x1d, 0xd0, 0xfc], 12); // loop: INC A ; DEC X ; BNE loop
	assert.equal(apu.a, 3);
	run(
		[
			0x3f, 0x10, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe8, 0x55,
			0x6f,
		],
		3,
	); // CALL $0410 ; MOV A,#$55 ; RET
	assert.equal(apu.a, 0x55);
	assert.equal(apu.pc, 0x0403);
});

test('SPC file: header, strings and the BRR voice at the pitch the DSP registers dictate', () => {
	const file = buildSpc(
		(ram) => {
			ram.set(SQUARE_BRR, 0x0300);
			ram.set([0x00, 0x03, 0x00, 0x03], 0x0200); // directory entry 0: start and loop address $0300
			ram.set(
				dspProgram([
					[0x6c, 0x20],
					[0x5d, 0x02],
					[0x0c, 0x7f],
					[0x1c, 0x7f],
					[0x00, 0x7f],
					[0x01, 0x7f],
					[0x02, 0x00],
					[0x03, 0x10],
					[0x04, 0x00],
					[0x05, 0x00],
					[0x07, 0x7f],
					[0x4c, 0x01],
				]),
				0x0400,
			);
		},
		{ 0x6c: 0x20 },
	);
	assert.ok(isSpc(file));
	assert.equal(detectFormat(file), 'spc');
	const player = new SpcPlayer(file, { sampleRate: RATE, seconds: 1 });
	assert.equal(player.info.title, 'Test tune');
	const out = renderPlayer(player, { maxSeconds: 3 });
	assert.ok(out.ended && Math.abs(out.duration - 1) < 0.01);
	assert.ok(peak(out.left) > 0.1, 'sound');
	// pitch 0x1000 = 32 kHz source rate; the 16 sample cycle gives 2000 Hz
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 4) - 2000) < 8, `${frequency(out.left, RATE)}`);
	// a pitch of 0x0800 is an octave lower
	const low = buildSpc(
		(ram) => {
			ram.set(SQUARE_BRR, 0x0300);
			ram.set([0x00, 0x03, 0x00, 0x03], 0x0200);
			ram.set(
				dspProgram([
					[0x5d, 0x02],
					[0x0c, 0x7f],
					[0x1c, 0x7f],
					[0x00, 0x7f],
					[0x01, 0x7f],
					[0x02, 0x00],
					[0x03, 0x08],
					[0x07, 0x7f],
					[0x4c, 0x01],
				]),
				0x0400,
			);
		},
		{ 0x6c: 0x20 },
	);
	const lo = renderPlayer(new SpcPlayer(low, { sampleRate: RATE, seconds: 1 }), { maxSeconds: 3 });
	assert.ok(Math.abs(frequency(lo.left, RATE, RATE / 4) - 1000) < 6, `${frequency(lo.left, RATE)}`);
});

test('the timers count at 8 kHz (timers 0 and 1) and 64 kHz (timer 2)', () => {
	const count = (timer: number, target: number): number => {
		const apu = new SnesApu();
		// enable timer `timer`, set its target, then spin
		apu.ram.set([0x8f, 1 << timer, 0xf1, 0x8f, target, 0xfa + timer, 0x2f, 0xfe], 0x0400);
		apu.pc = 0x0400;
		for (let i = 0; i < 400; i++) apu.nextSample(); // 12800 SPC700 cycles
		apu.ram.set([0xe4, 0xfd + timer], 0x0500); // MOV A,$FD+timer reads and clears the 4 bit output
		apu.pc = 0x0500;
		apu.step();
		return apu.a;
	};
	// timer 0 at 8 kHz with a target of 8: one output every 1024 cycles, 12800 cycles give 12 outputs
	assert.ok(Math.abs(count(0, 8) - 12) <= 1, `timer 0: ${count(0, 8)}`);
	// timer 2 runs 8 times faster: the same target gives 100 outputs, seen modulo 16
	assert.ok(Math.abs(count(2, 8) - (100 % 16)) <= 1, `timer 2: ${count(2, 8)}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppleSpeaker, Mockingboard } from '../src/chips/AppleII.ts';
import { AppleIIPlayer, MwaPlayer, MwaRecorder, decodeMwa, encodeMwa } from '../src/formats/index.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { compareAudio } from '../src/driver/Compare.ts';
import { frequency, peak, renderMono, RATE } from './util.ts';

const CLOCK = 1_020_484;

function memoryWith(program: number[], at = 0x0800, extra: (m: Uint8Array) => void = () => {}): Uint8Array {
	const m = new Uint8Array(65536);
	m.set(program, at);
	extra(m);
	return m;
}

test('speaker: any access toggles, the output of a sample is the exact average of the two levels', () => {
	const sp = new AppleSpeaker({ sampleRate: RATE, level: 1 });
	const l = new Float32Array(4);
	const r = new Float32Array(4);
	sp.writeAt(0.25, 0xc030, 0); // one toggle a quarter of the way into the first sample
	sp.render(l, r, 0, 4);
	assert.ok(Math.abs(l[0] - (0.25 * 1 - 0.75 * 1)) < 1e-6, `first sample ${l[0]}`);
	assert.ok(Math.abs(l[1] + 1) < 1e-6 && Math.abs(l[3] + 1) < 1e-6, 'level held after the toggle');
	// a read toggles as well, writes to other addresses do nothing
	const sp2 = new AppleSpeaker({ sampleRate: RATE, level: 1 });
	sp2.read(0xc030);
	sp2.write(0xc031, 0);
	const out = new Float32Array(2);
	sp2.render(out, new Float32Array(2), 0, 2);
	assert.deepEqual([...out], [-1, -1]);
	// two toggles inside one sample cancel in the average like a short click
	const sp3 = new AppleSpeaker({ sampleRate: RATE, level: 1 });
	sp3.writeAt(0.25, 0xc030, 0);
	sp3.writeAt(0.5, 0xc030, 0);
	const c = new Float32Array(1);
	sp3.render(c, new Float32Array(1), 0, 1);
	assert.ok(Math.abs(c[0] - (0.25 - 0.25 + 0.5)) < 1e-6);
});

test('a 6502 delay loop toggling $C030 gives the pitch its cycle count dictates', () => {
	// loop: LDY #100 ; delay: DEY ; BNE delay ; LDA $C030 ; JMP loop   -> 508 cycles between toggles
	const program = [0xa0, 100, 0x88, 0xd0, 0xfd, 0xad, 0x30, 0xc0, 0x4c, 0x00, 0x08];
	const player = new AppleIIPlayer({
		memory: memoryWith(program),
		entry: 0x0800,
		sampleRate: RATE,
		slot: 0,
		maxSeconds: 2,
	});
	const out = renderPlayer(player, { maxSeconds: 5 });
	const expected = CLOCK / (2 * (2 + 100 * 5 - 1 + 4 + 3));
	assert.ok(
		Math.abs(frequency(out.left, RATE, RATE / 2) - expected) < 0.6,
		`${frequency(out.left, RATE)} vs ${expected}`,
	);
	assert.ok(out.ended && Math.abs(out.duration - 2) < 0.01);
});

test('PAL Apple II clock lowers the pitch by the clock ratio', () => {
	const program = [0xa0, 100, 0x88, 0xd0, 0xfd, 0xad, 0x30, 0xc0, 0x4c, 0x00, 0x08];
	const f = (standard: 'ntsc' | 'pal'): number =>
		frequency(
			renderPlayer(
				new AppleIIPlayer({
					memory: memoryWith(program),
					entry: 0x0800,
					sampleRate: RATE,
					slot: 0,
					maxSeconds: 1,
					standard,
				}),
				{ maxSeconds: 3 },
			).left,
			RATE,
			RATE / 4,
		);
	assert.ok(Math.abs(f('pal') / f('ntsc') - 1_015_657 / 1_020_484) < 0.002);
});

/** machine code writing AY register `reg` through the 6522 port protocol of slot 4 (VIA 1) */
function ayWrite(reg: number, value: number, via = 0xc400): number[] {
	const [orb, ora] = [via & 0xff, (via & 0xff) + 1];
	const hi = via >> 8;
	return [
		0xa9,
		reg,
		0x8d,
		ora,
		hi, // LDA #reg ; STA ORA
		0xa9,
		0x07,
		0x8d,
		orb,
		hi, // latch address
		0xa9,
		0x04,
		0x8d,
		orb,
		hi, // inactive
		0xa9,
		value,
		0x8d,
		ora,
		hi, // LDA #value ; STA ORA
		0xa9,
		0x06,
		0x8d,
		orb,
		hi, // write
		0xa9,
		0x04,
		0x8d,
		orb,
		hi, // inactive
	];
}

test('Mockingboard: the VIA protocol drives the AY, left chip on VIA 1 and right chip on VIA 2', () => {
	const setup = [
		0xa9, 0xff, 0x8d, 0x03, 0xc4, 0x8d, 0x02, 0xc4, 0x8d, 0x83, 0xc4, 0x8d, 0x82, 0xc4, 0xa9, 0x00, 0x8d, 0x00,
		0xc4, 0x8d, 0x80, 0xc4, 0xa9, 0x04, 0x8d, 0x00, 0xc4, 0x8d, 0x80, 0xc4,
	];
	const program = [
		...setup,
		...ayWrite(0, 100),
		...ayWrite(7, 0x3e),
		...ayWrite(8, 15), // left: tone A, period 100
		...ayWrite(0, 50, 0xc480),
		...ayWrite(7, 0x3e, 0xc480),
		...ayWrite(8, 15, 0xc480), // right: period 50
		0x4c,
		0x00 + 0,
		0x00, // placeholder, patched below
	];
	const end = 0x0800 + program.length - 3;
	program[program.length - 2] = end & 255;
	program[program.length - 1] = end >> 8;
	const player = new AppleIIPlayer({
		memory: memoryWith(program),
		entry: 0x0800,
		sampleRate: RATE,
		slot: 4,
		maxSeconds: 1.5,
	});
	const out = renderPlayer(player, { maxSeconds: 5 });
	assert.ok(Math.abs(frequency(out.left, RATE, RATE / 2) - CLOCK / 1600) < 0.8, `left ${frequency(out.left, RATE)}`);
	assert.ok(
		Math.abs(frequency(out.right, RATE, RATE / 2) - CLOCK / 800) < 1.5,
		`right ${frequency(out.right, RATE)}`,
	);
});

test('Mockingboard: VIA timer 1 in free run interrupts the CPU every N + 2 cycles; the handler runs', () => {
	const n = 10000;
	// main: DDRs, ACR = free run, T1 latch = n, start T1, enable the T1 interrupt, CLI, spin
	const main = [
		0xa9,
		0x40,
		0x8d,
		0x0b,
		0xc4, // ACR: free run
		0xa9,
		n & 255,
		0x8d,
		0x04,
		0xc4, // T1L-L
		0xa9,
		n >> 8,
		0x8d,
		0x05,
		0xc4, // T1C-H: loads and starts
		0xa9,
		0xc0,
		0x8d,
		0x0e,
		0xc4, // IER: enable T1
		0x58, // CLI
		0x4c,
		0x15,
		0x08, // spin: JMP to its own address
	];
	// handler at $0900: INC $10 ; LDA $C404 (reading T1C-L clears the flag) ; RTI
	const handler = [0xe6, 0x10, 0xad, 0x04, 0xc4, 0x40];
	const mem = memoryWith(main, 0x0800, (m) => {
		m.set(handler, 0x0900);
		m[0xfffe] = 0x00;
		m[0xffff] = 0x09;
	});
	const player = new AppleIIPlayer({ memory: mem, entry: 0x0800, sampleRate: RATE, slot: 4, maxSeconds: 1 });
	renderPlayer(player, { maxSeconds: 3 });
	const expected = CLOCK / (n + 2);
	assert.ok(Math.abs(player.peek(0x10) - expected) <= 1.5, `${player.peek(0x10)} interrupts vs ${expected}`);
});

test('Mockingboard chip: VIA registers, T1 / T2 flags and the AY register read-back', () => {
	const events: boolean[] = [];
	const mb = new Mockingboard({ sampleRate: RATE, onIrq: (a) => events.push(a) });
	mb.write(0x0e, 0xc0); // enable T1 interrupt
	mb.write(0x0b, 0x00); // one shot
	mb.write(0x04, 10);
	mb.write(0x05, 0);
	mb.tick(5);
	assert.equal(mb.read(0x0d) & 0x40, 0, 'not yet');
	mb.tick(10);
	assert.ok(mb.read(0x0d) & 0x40, 'T1 flag set');
	assert.ok(mb.irq && events[0] === true);
	mb.read(0x04); // reading the low counter clears the flag
	assert.ok(!mb.irq && events[1] === false);
	mb.write(0x08, 20); // T2
	mb.write(0x09, 0);
	mb.tick(30);
	assert.ok(mb.read(0x0d) & 0x20, 'T2 flag set');
	mb.write(0x0d, 0x20); // writing a 1 clears the flag
	assert.equal(mb.read(0x0d) & 0x20, 0);
	// AY register read-back through BC1 = 1, BDIR = 0
	mb.write(0x02, 0xff);
	mb.write(0x03, 0xff);
	mb.write(0x01, 3);
	mb.write(0x00, 0x07);
	mb.write(0x00, 0x04);
	mb.write(0x01, 0x0a);
	mb.write(0x00, 0x06);
	mb.write(0x00, 0x04);
	mb.write(0x03, 0x00); // port A now an input
	mb.write(0x00, 0x05); // read mode
	assert.equal(mb.read(0x01), 0x0a);
	// direct register access for logs of an AY alone
	mb.write(0x100 | 0x10, 0x00);
});

test('an execution recorded with the cycle timebase replays to the same audio', async () => {
	const program = [0xa0, 100, 0x88, 0xd0, 0xfd, 0xad, 0x30, 0xc0, 0x4c, 0x00, 0x08];
	const recorder = new MwaRecorder({ timebase: CLOCK });
	const player = new AppleIIPlayer({
		memory: memoryWith(program),
		entry: 0x0800,
		sampleRate: RATE,
		slot: 0,
		maxSeconds: 1,
		chipFactory: recorder.factory,
	});
	const direct = renderPlayer(player, { maxSeconds: 3 });
	const mwa = await encodeMwa(recorder.finish({ frameRate: 60 }));
	assert.ok(mwa.length < 40000, `compact: ${mwa.length} bytes for 2000 toggles`);
	const replay = renderPlayer(new MwaPlayer(decodeMwa(mwa), { sampleRate: RATE }), { maxSeconds: 3 });
	const cmp = compareAudio(replay.left, direct.left, {
		tolerance: 0.02,
		from: 2000,
		to: Math.min(replay.left.length, direct.left.length) - 2000,
	});
	assert.ok(cmp.ok, `replay error ${cmp.relativeError}`);
	assert.ok(peak(renderMono(new AppleSpeaker({ sampleRate: RATE }), 0.01)) >= 0);
});

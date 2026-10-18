import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadNsf } from '../src/formats/nsf.ts';
import { loadPsid } from '../src/formats/psid.ts';
import { loadSpc } from '../src/formats/spc.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';

/** what mwg's `InstructionBudget` does, in miniature: counts, and throws once the allowance is gone */
class Allowance {
	left: number;
	spent = 0;
	constructor(allowance: number) {
		this.left = allowance;
	}
	spend(count = 1): void {
		this.spent += count;
		this.left -= count;
		if (this.left < 0) throw new Error('over the instruction budget');
	}
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** an NSF whose play routine is `JMP $8001`: it never returns, so only the cycle limit stops each frame */
function nsfThatNeverReturns(): Uint8Array {
	const h = new Uint8Array(0x80);
	h.set([0x4e, 0x45, 0x53, 0x4d, 0x1a, 1, 1, 1]);
	const v = new DataView(h.buffer);
	v.setUint16(8, 0x8000, true);
	v.setUint16(10, 0x8000, true);
	v.setUint16(12, 0x8001, true);
	v.setUint16(0x6e, 16666, true);
	v.setUint16(0x78, 20000, true);
	return Uint8Array.from([...h, 0x60, 0x4c, 0x01, 0x80]);
}

/** a PSID whose play routine is `JMP $1100` */
function psidThatNeverReturns(): Uint8Array {
	const h = new Uint8Array(0x7c);
	h.set([0x50, 0x53, 0x49, 0x44]);
	const v = new DataView(h.buffer);
	v.setUint16(4, 2);
	v.setUint16(6, 0x7c);
	v.setUint16(8, 0x1000);
	v.setUint16(10, 0x1000);
	v.setUint16(12, 0x1100);
	v.setUint16(14, 1);
	v.setUint16(16, 1);
	const body = new Array<number>(0x200).fill(0xea);
	body[0] = 0x60;
	body.splice(0x100, 3, 0x4c, 0x00, 0x11);
	return Uint8Array.from([...h, ...body]);
}

/** an SPC snapshot running `BRA self` forever */
function spcThatSpins(): Uint8Array {
	const f = new Uint8Array(0x10200);
	f.set(ascii('SNES-SPC700 Sound File Data v0.30'));
	f[0x21] = f[0x22] = f[0x23] = 26;
	f[0x24] = 30;
	f[0x25] = 0x00;
	f[0x26] = 0x04;
	f[0x2b] = 0xef;
	f.set(ascii('5'), 0xa9);
	f.set([0x2f, 0xfe], 0x100 + 0x0400);
	return f;
}

test('an NSF that never returns is stopped by the instruction budget, by name, instead of grinding on', () => {
	const bytes = nsfThatNeverReturns();
	const budget = new Allowance(10_000);
	assert.throws(
		() => renderPlayer(loadNsf(bytes, { sampleRate: 8000, budget }), { maxSeconds: 1 }),
		/instruction budget/,
	);
	assert.ok(budget.spent > 10_000, 'what the loop ran before it was stopped was charged');
	//with no budget the same file still renders, bounded by the cycle limit of each frame as before
	assert.doesNotThrow(() => renderPlayer(loadNsf(bytes, { sampleRate: 8000 }), { maxSeconds: 0.05 }));
});

test('a PSID that never returns is stopped by the instruction budget too', () => {
	const budget = new Allowance(10_000);
	assert.throws(
		() => renderPlayer(loadPsid(psidThatNeverReturns(), { sampleRate: 8000, budget }), { maxSeconds: 1 }),
		/instruction budget/,
	);
	assert.ok(budget.spent > 10_000);
});

test('a spinning SPC is charged one instruction per step and stopped by the budget', () => {
	const spentFor = (seconds: number): number => {
		const budget = new Allowance(1e9);
		renderPlayer(loadSpc(spcThatSpins(), { sampleRate: 8000, budget, seconds: 1 }), { maxSeconds: seconds });
		return budget.spent;
	};
	const half = spentFor(0.125);
	const whole = spentFor(0.25);
	assert.ok(half > 10_000, `${half} instructions for an eighth of a second of a spinning program`);
	assert.ok(whole / half > 1.9 && whole / half < 2.1, 'the charge follows the seconds of sound rendered');
	const tight = new Allowance(1000);
	assert.throws(
		() => renderPlayer(loadSpc(spcThatSpins(), { sampleRate: 8000, budget: tight, seconds: 1 }), { maxSeconds: 1 }),
		/instruction budget/,
	);
});

test('a budget does not change the sound: the same file renders identically with and without one', () => {
	const plain = renderPlayer(loadSpc(spcThatSpins(), { sampleRate: 8000, seconds: 1 }), { maxSeconds: 0.1 });
	const counted = renderPlayer(
		loadSpc(spcThatSpins(), { sampleRate: 8000, budget: new Allowance(1e9), seconds: 1 }),
		{
			maxSeconds: 0.1,
		},
	);
	assert.deepEqual(counted.left, plain.left);
});

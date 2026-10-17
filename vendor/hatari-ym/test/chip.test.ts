import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HatariYm } from '../src/ym2149.ts';
import { HatariYmChip, registerHatariYm } from '../src/chip.ts';

test('the chip adapter produces what HatariYm produces for the same writes', () => {
	const rate = 44100;
	const chip = new HatariYmChip({ sampleRate: rate });
	const left = new Float32Array(rate);
	const right = new Float32Array(rate);
	chip.write(0, 100);
	chip.write(7, 0b111110);
	chip.write(8, 15);
	chip.render(left, right, 0, rate / 2);
	chip.write(0, 50); // pitch change at exactly the half second
	chip.render(left, right, rate / 2, rate / 2);
	// reference: the same register writes at the same CPU clocks on a bare HatariYm
	const ref = new HatariYm({ machine: 'stf-pal', sampleRate: rate });
	const start = Math.round(ref.cpuFreq * 0.5);
	ref.reset(0);
	const at = (frames: number): number => start + Math.round((frames * ref.cpuFreq) / rate);
	ref.writeData(at(0), 0, 100);
	ref.writeData(at(0), 7, 0b111110);
	ref.writeData(at(0), 8, 15);
	ref.writeData(at(rate / 2), 0, 50);
	ref.update(at(rate));
	const samples = ref.takeSamples();
	const n = Math.min(samples.length, left.length) - 2;
	assert.ok(n > rate * 0.9, `${n} samples compared`);
	for (let i = 0; i < n; i++) assert.equal(left[i], samples[i] / 32768, `sample ${i}`);
	assert.deepEqual(left.subarray(0, 200), right.subarray(0, 200));
});

test('registerHatariYm registers a ym2149 factory', () => {
	let registered = '';
	registerHatariYm((id, factory) => {
		registered = id;
		assert.equal(factory({ sampleRate: 44100 }).id, 'ym2149');
	});
	assert.equal(registered, 'ym2149');
});

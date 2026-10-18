import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chipIds, createChip, registerChip } from '../src/chips/index.ts';
import { Ym2149 } from '../src/chips/Ym2149.ts';

test('builtin factories remain discoverable and preserve AY and OPL variants', () => {
	const ids = chipIds();
	assert.equal(ids.length, 34);
	assert.equal(new Set(ids).size, ids.length);
	for (const id of ids) {
		const chip = createChip(id, { sampleRate: 8000 });
		assert.equal(chip.sampleRate, 8000, id);
		const left = new Float32Array(32);
		chip.render(left, new Float32Array(32), 0, 32);
		assert(left.every(Number.isFinite), id);
	}
	assert.throws(() => createChip('toString'), /unknown chip/);
	assert.throws(() => createChip('__proto__'), /unknown chip/);
});

test('custom factories override builtins without duplicating ids', () => {
	const expected = new Ym2149({ sampleRate: 12345 });
	registerChip('ym2149', () => expected);
	assert.equal(createChip('ym2149'), expected);
	assert.equal(chipIds().filter((id) => id === 'ym2149').length, 1);
	registerChip('ym2149', (options) => new Ym2149(options));
	registerChip('test:custom', () => expected);
	assert.equal(createChip('test:custom'), expected);
	assert(chipIds().includes('test:custom'));
});

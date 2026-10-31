import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRendering } from '../src/driver/scorecard.ts';
import { SPEECH_REGISTERS as R, SpeechChip } from '../src/speech/SpeechChip.ts';

const RATE = 22050;

function renderVowel(f1: number, f2: number, seconds = 1): Float32Array {
	const chip = new SpeechChip({ sampleRate: RATE });
	chip.write(R.F0, (220 * 16) & 255);
	chip.write(R.F0 + 1, (220 * 16) >> 8);
	chip.write(R.F1, f1 & 255);
	chip.write(R.F1 + 1, f1 >> 8);
	chip.write(R.F2, f2 & 255);
	chip.write(R.F2 + 1, f2 >> 8);
	chip.write(R.VOICE, 255);
	const n = Math.round(seconds * RATE);
	const left = new Float32Array(n);
	chip.render(left, new Float32Array(n), 0, n);
	return left;
}

test('the speech chip makes a voiced sound from register writes and adds to the buffers', () => {
	const x = renderVowel(750, 1300);
	assert.ok(x.some((s) => Math.abs(s) > 0.01));
	const chip = new SpeechChip({ sampleRate: RATE });
	const left = new Float32Array(100).fill(1);
	chip.render(left, new Float32Array(100), 0, 100);
	assert.ok(left.every((s) => s === 1)); // unvoiced and silent: nothing added
});

test('muting silences the chip', () => {
	const chip = new SpeechChip({ sampleRate: RATE });
	chip.write(R.F0, 100);
	chip.write(R.VOICE, 255);
	chip.setMuted(0, true);
	const left = new Float32Array(500);
	chip.render(left, new Float32Array(500), 0, 500);
	assert.ok(left.every((s) => s === 0));
});

test('the scorecard ranks a closer rendering as closer', () => {
	const reference = renderVowel(750, 1300);
	const same = scoreRendering(reference, reference, RATE);
	assert.equal(same.spectralDistance, 0);
	assert.equal(same.pitchClassDistance, 0);
	assert.ok(same.loudnessError < 1e-9);
	const near = scoreRendering(renderVowel(760, 1310), reference, RATE);
	const far = scoreRendering(renderVowel(300, 2300), reference, RATE);
	assert.ok(near.spectralDistance < far.spectralDistance);
});

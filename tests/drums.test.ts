import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DrumMachine } from '../src/sfx/DrumMachine.ts';

const RATE = 22050;

function energy(x: Float32Array, from: number, to: number): number {
	let e = 0;
	for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) e += x[i] ** 2;
	return e;
}

test('a step pattern places hits on the tempo grid', () => {
	const drums = new DrumMachine({ sampleRate: RATE });
	const hits = drums.pattern('kick', 'x...x...x...x...', 120);
	assert.deepEqual(
		hits.map((h) => h.time),
		[0, 0.5, 1, 1.5],
	);
});

test('rendering is audible at the hits and silent between them', () => {
	const drums = new DrumMachine({ sampleRate: RATE });
	const x = drums.render([{ voice: 'snare', time: 0.5 }], 1.5);
	assert.equal(x.length, Math.round(1.5 * RATE));
	assert.ok(energy(x, 0.5, 0.6) > 1);
	assert.equal(energy(x, 0, 0.49), 0);
	assert.equal(energy(x, 0.9, 1.5), 0);
});

test('the kick is low and the hat is high', () => {
	const drums = new DrumMachine({ sampleRate: RATE });
	const centroid = (voice: 'kick' | 'hat'): number => {
		const x = drums.render([{ voice, time: 0 }], 0.1);
		let crossings = 0;
		for (let i = 1; i < x.length; i++) if (x[i - 1] <= 0 !== x[i] <= 0) crossings++;
		return crossings;
	};
	assert.ok(centroid('hat') > 5 * centroid('kick'));
});

test('drums are deterministic and hits past the end are cut', () => {
	const hits = [{ voice: 'clap' as const, time: 0.95 }];
	assert.deepEqual(new DrumMachine().render(hits, 1), new DrumMachine().render(hits, 1));
	assert.equal(new DrumMachine().render(hits, 1).length, 44100);
});

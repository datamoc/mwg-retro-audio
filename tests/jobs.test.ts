import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	composeCue,
	composeCueAsync,
	composeNotes,
	composeNotesAsync,
	foldLoop,
	scoreToMidiFile,
} from '../src/compose/index.ts';
import { parseSmf } from '../src/formats/midi.ts';
import { loadFile } from '../src/formats/load.ts';
import { renderPlayerAsync } from '../src/driver/Renderer.ts';
import { renderFileAsync } from '../src/driver/renderFile.ts';
import { nodeJobWorker } from './helpers/nodeJobWorker.ts';

const composeWorker = () => nodeJobWorker('compose/composeJob.ts', 'handleComposeMessage');
const renderWorker = () => nodeJobWorker('driver/renderJob.ts', 'handleRenderMessage');
const options = { style: 'dos-opl2-1987', seed: 7, duration: 8, sampleRate: 16000 };

/** a mono 16 bit WAV of a decaying 440 Hz tone */
function tinyWav(seconds = 0.5, rate = 8000): Uint8Array {
	const count = Math.round(seconds * rate);
	const out = new Uint8Array(44 + count * 2);
	const view = new DataView(out.buffer);
	out.set([0x52, 0x49, 0x46, 0x46], 0);
	view.setUint32(4, 36 + count * 2, true);
	out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	out.set([0x64, 0x61, 0x74, 0x61], 36);
	view.setUint32(40, count * 2, true);
	for (let i = 0; i < count; i++) {
		const sample = 12000 * Math.sin((2 * Math.PI * 440 * i) / rate) * (1 - i / count);
		view.setInt16(44 + i * 2, Math.round(sample), true);
	}
	return out;
}

test('composeCueAsync on a real worker thread gives the cue of composeCue, sample for sample, with progress', async () => {
	const worker = composeWorker();
	const progress: number[] = [];
	const cue = await composeCueAsync(options, { worker: () => worker, onProgress: (f) => progress.push(f) });
	const direct = composeCue(options);
	assert.deepEqual(cue.left, direct.left);
	assert.deepEqual(cue.right, direct.right);
	assert.equal(cue.seconds, direct.seconds);
	assert.deepEqual(cue.style, direct.style);
	assert.ok(worker.terminated, 'one worker per job, terminated at the end');
	assert.ok(
		progress.length > 3 && progress.every((f, i) => i === 0 || f >= progress[i - 1]) && progress.at(-1) === 1,
	);
});

test('composeCueAsync without a worker runs in the calling thread with the same result, progress and cancel', async () => {
	const progress: number[] = [];
	const cue = await composeCueAsync(options, { worker: false, onProgress: (f) => progress.push(f) });
	assert.deepEqual(cue.left, composeCue(options).left);
	assert.equal(progress.at(-1), 1);
	const stop = new AbortController();
	await assert.rejects(
		composeCueAsync(options, {
			worker: false,
			signal: stop.signal,
			onProgress: (f) => f > 0.1 && stop.abort(new Error('stop')),
		}),
		/stop/,
	);
	await assert.rejects(
		composeCueAsync(options, { worker: false, signal: AbortSignal.abort(new Error('before')) }),
		/before/,
	);
});

test('aborting terminates the worker and rejects with the reason', async () => {
	const worker = composeWorker();
	const stop = new AbortController();
	const pending = composeCueAsync(
		{ ...options, duration: 120, sampleRate: 44100 },
		{ worker: () => worker, signal: stop.signal },
	);
	setTimeout(() => stop.abort(new Error('cancelled')), 100);
	await assert.rejects(pending, /cancelled/);
	assert.ok(worker.terminated);
});

test('a failing job rejects with the message of the worker', async () => {
	await assert.rejects(
		composeCueAsync({ ...options, style: 'no-such-style' }, { worker: composeWorker }),
		/unknown style/,
	);
});

test('composeNotes: the same music as the cue, as MIDI events a file can hold and a worker can compute', async () => {
	const score = composeNotes(options);
	assert.deepEqual(score, composeNotes(options), 'deterministic');
	assert.notDeepEqual(score.events, composeNotes({ ...options, seed: 8 }).events, 'the seed changes the notes');
	const programs = score.events.filter((e) => e.status >> 4 === 0xc);
	assert.deepEqual(programs.map((e) => e.status & 15).sort(), [0, 1, 2]);
	const strikes = score.events.filter((e) => e.status >> 4 === 9);
	const channels = new Set(strikes.map((e) => e.status & 15));
	assert.deepEqual(
		[...channels].sort((a, b) => a - b),
		[0, 1, 2, 9],
	);
	assert.equal(strikes.length, score.events.filter((e) => e.status >> 4 === 8).length, 'every note is released');
	// a note struck near the end rings on past it: that is what foldLoop folds back
	assert.ok(strikes.every((e) => e.time >= 0 && e.time < score.seconds));
	assert.ok(score.events.every((e) => e.time <= score.seconds + 2));
	assert.equal(
		composeNotes({ ...options, drums: false }).events.some((e) => (e.status & 15) === 9),
		false,
	);
	assert.equal(composeNotes({ ...options, programs: { lead: 7 } }).events.find((e) => e.status === 0xc2)?.data1, 7);
	const song = parseSmf(scoreToMidiFile(score));
	assert.equal(song.events.filter((e) => e.status >> 4 === 9).length, strikes.length);
	assert.deepEqual(await composeNotesAsync(options, { worker: composeWorker }), score);
});

test('foldLoop keeps every sample of the tail, at the start, and the length of the loop', () => {
	const rendered = {
		sampleRate: 10,
		left: Float32Array.from([1, 2, 3, 4, 5]),
		right: Float32Array.from([0, 0, 0, 0, 1]),
	};
	const folded = foldLoop(rendered, 0.3);
	assert.deepEqual([...folded.left], [5, 7, 3]);
	assert.deepEqual([...folded.right], [0, 1, 0]);
	assert.equal(folded.duration, 0.3);
	assert.equal(folded.loopEnd, 0.3);
});

test('renderFileAsync on a real worker thread renders the file as renderPlayerAsync does', async () => {
	const bytes = tinyWav();
	const worker = renderWorker();
	const progress: number[] = [];
	const rendered = await renderFileAsync(bytes, {
		worker: () => worker,
		load: { name: 'tone.wav' },
		maxSeconds: 5,
		onProgress: (f) => progress.push(f),
	});
	const direct = await renderPlayerAsync(loadFile(bytes, { name: 'tone.wav' }), { maxSeconds: 5 });
	assert.ok(direct.left.some((v) => Math.abs(v) > 0.01));
	assert.deepEqual(rendered.left, direct.left);
	assert.deepEqual(rendered.right, direct.right);
	assert.equal(rendered.sampleRate, direct.sampleRate);
	assert.equal(rendered.ended, direct.ended);
	assert.ok(worker.terminated);
	assert.equal(progress.at(-1), 1);
	const inline = await renderFileAsync(bytes, { worker: false, load: { name: 'tone.wav' }, maxSeconds: 5 });
	assert.deepEqual(inline.left, direct.left);
});

test('renderFileAsync refuses a function option, rejects a file it cannot load and can be cancelled', async () => {
	await assert.rejects(
		renderFileAsync(tinyWav(), { load: { chipFactory: (() => {}) as never } }),
		/chipFactory.*renderPlayerAsync/,
	);
	await assert.rejects(renderFileAsync(Uint8Array.from([1, 2, 3, 4]), { worker: renderWorker }), /./);
	const worker = renderWorker();
	const stop = new AbortController();
	const pending = renderFileAsync(tinyWav(), { worker: () => worker, signal: stop.signal });
	stop.abort(new Error('gone'));
	await assert.rejects(pending, /gone/);
	assert.ok(worker.terminated);
});

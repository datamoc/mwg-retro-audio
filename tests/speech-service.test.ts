import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechService, synthesizeSpeech, type SpeechRequest, type SpeechWorkerLike } from '../src/speech/index.ts';

/** a worker that follows the protocol of speech.worker.ts and runs in this thread, counting its messages */
function fakeWorker(options: { fail?: boolean } = {}): SpeechWorkerLike & { posted: unknown[]; terminated: boolean } {
	const listeners = new Set<(event: { data?: unknown }) => void>();
	const worker = {
		posted: [] as unknown[],
		terminated: false,
		postMessage(message: unknown) {
			worker.posted.push(message);
			const { id, request } = message as { id: number; request: SpeechRequest };
			queueMicrotask(() => {
				const answer = options.fail
					? { id, success: false, error: 'boom' }
					: { id, success: true, ...synthesizeSpeech(request) };
				for (const listener of listeners) listener({ data: answer });
			});
		},
		addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
			if (type === 'message') listeners.add(listener);
		},
		removeEventListener(_type: string, listener: (event: { data?: unknown }) => void) {
			listeners.delete(listener);
		},
		terminate() {
			worker.terminated = true;
		},
	};
	return worker;
}

const RATE = 22050;

test('a line is synthesized through the worker and comes back as PCM at the asked level', async () => {
	const worker = fakeWorker();
	const service = new SpeechService({ worker });
	assert.ok(service.usesWorker);
	const result = await service.speak('bonjour', { sampleRate: RATE, level: 0.5 });
	assert.equal(result.sampleRate, RATE);
	assert.ok(result.samples.length > RATE * 0.3);
	let peak = 0;
	for (const s of result.samples) peak = Math.max(peak, Math.abs(s));
	assert.ok(Math.abs(peak - 0.5) < 1e-3);
	assert.equal(worker.posted.length, 1);
});

test('several lines at once are matched to their own answers', async () => {
	const service = new SpeechService({ worker: fakeWorker() });
	const [short, long] = await Promise.all([
		service.speak('oui', { sampleRate: RATE }),
		service.speak('bonjour tout le monde', { sampleRate: RATE }),
	]);
	assert.ok(long.samples.length > short.samples.length);
});

test('a repeated line comes from the cache, not from the worker', async () => {
	const worker = fakeWorker();
	const service = new SpeechService({ worker });
	const first = await service.speak('attention', { sampleRate: RATE });
	const second = await service.speak('attention', { sampleRate: RATE });
	assert.equal(first, second);
	assert.equal(worker.posted.length, 1);
	await service.speak('attention', { sampleRate: RATE, whisper: true });
	assert.equal(worker.posted.length, 2);
	const uncached = new SpeechService({ worker: fakeWorker(), cacheSize: 0 });
	await uncached.speak('a', { sampleRate: RATE });
	await uncached.speak('a', { sampleRate: RATE });
});

test('a failure in the worker rejects the line and is not cached', async () => {
	const service = new SpeechService({ worker: fakeWorker({ fail: true }) });
	await assert.rejects(service.speak('oui', { sampleRate: RATE }), /boom/);
	await assert.rejects(service.speak('oui', { sampleRate: RATE }), /boom/);
});

test('without a worker the line is synthesized in the calling thread', async () => {
	const service = new SpeechService({ worker: false });
	assert.ok(!service.usesWorker);
	const result = await service.speak('hello', { language: 'en', sampleRate: RATE });
	assert.ok(result.samples.length > 0);
	assert.deepEqual(
		result.samples,
		synthesizeSpeech({ text: 'hello', language: 'en', options: { sampleRate: RATE } }).samples,
	);
});

test('dispose stops the worker and rejects what is still waiting', async () => {
	const worker = fakeWorker();
	const service = new SpeechService({ worker });
	const waiting = service.speak('un deux trois', { sampleRate: RATE });
	service.dispose();
	await assert.rejects(waiting, /disposed/);
	assert.ok(worker.terminated);
});

test('the samples become a mono Web Audio buffer without decoding', async () => {
	const service = new SpeechService({ worker: false });
	const result = await service.speak('oui', { sampleRate: RATE });
	let created: { channels: number; length: number; rate: number } | undefined;
	const buffer = service.toAudioBuffer(
		{
			createBuffer(channels, length, rate) {
				created = { channels, length, rate };
				return { copyToChannel: () => undefined } as unknown as AudioBuffer;
			},
		},
		result,
	);
	assert.ok(buffer);
	assert.deepEqual(created, { channels: 1, length: result.samples.length, rate: RATE });
});

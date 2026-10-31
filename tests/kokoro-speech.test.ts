import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KokoroSpeech, type KokoroEngine } from '../src/speech/KokoroSpeech.ts';
import { normalizeFrenchPhonemes, splitSpeechText } from '../src/speech/kokoroFrench.ts';

function fakeEngine() {
	let renders = 0;
	let disposed = false;
	const engine: KokoroEngine = {
		voices: {
			af_heart: { name: 'Heart', language: 'en-us', gender: 'Female' },
			bf_emma: { name: 'Emma', language: 'en-gb', gender: 'Female' },
			ff_siwis: { name: 'Siwis', language: 'fr-fr', gender: 'Female' },
		},
		async *stream(text, options) {
			renders++;
			if (text === 'fail') throw new Error('inference failed');
			assert.ok(options.speed > 0);
			yield { audio: { audio: new Float32Array([0.1, 0.2]), sampling_rate: 24000 } };
			yield { audio: { audio: new Float32Array([0.3]), sampling_rate: 24000 } };
		},
		model: {
			async dispose() {
				disposed = true;
			},
		},
	};
	return { engine, renders: () => renders, disposed: () => disposed };
}

test('Kokoro loads lazily, shares loading and joins all generated chunks', async () => {
	const fake = fakeEngine();
	let loads = 0;
	const speech = new KokoroSpeech({
		load: async () => {
			loads++;
			return fake.engine;
		},
	});
	assert.equal(loads, 0);
	await Promise.all([speech.ready(), speech.ready()]);
	assert.equal(loads, 1);
	const result = await speech.speak('Hello');
	assert.equal(result.sampleRate, 24000);
	assert.deepEqual(result.samples, new Float32Array([0.1, 0.2, 0.3]));
	assert.equal((await speech.voices()).length, 3);
	await speech.dispose();
	assert.ok(fake.disposed());
});

test('Kokoro coalesces repeated requests and protects cached samples from callers', async () => {
	const fake = fakeEngine();
	const speech = new KokoroSpeech({ load: async () => fake.engine, cacheSize: 1 });
	const [first, second] = await Promise.all([speech.speak('Hello'), speech.speak('Hello')]);
	assert.equal(fake.renders(), 1);
	first.samples.fill(0);
	assert.notEqual(second.samples[0], 0);
	assert.notEqual((await speech.speak('Hello')).samples[0], 0);
	await speech.speak('Goodbye');
	await speech.speak('Hello');
	assert.equal(fake.renders(), 3);
	await speech.dispose();
});

test('Kokoro rejects unsupported languages and mismatched voice locales', async () => {
	let loads = 0;
	const fake = fakeEngine();
	const speech = new KokoroSpeech({
		load: async () => {
			loads++;
			return fake.engine;
		},
	});
	await assert.rejects(speech.speak('Hallo', { language: 'de-DE' as 'en-US' }), /Unsupported/);
	await assert.rejects(speech.speak('Hello', { rate: NaN }), /rate/);
	assert.equal(loads, 0);
	await assert.rejects(speech.speak('Hello', { voice: 'missing' }), /Unknown/);
	await assert.rejects(speech.speak('Hello', { voice: 'bf_emma', language: 'en-US' }), /speaks/);
	await speech.speak('Hello', { language: 'en-GB' });
	await speech.dispose();
});

test('French requires a phonemizer before downloading, and selects Siwis when configured', async () => {
	const unconfigured = new KokoroSpeech();
	await assert.rejects(unconfigured.speak('Bonjour', { language: 'fr-FR' }), /frenchPhonemize/);
	await unconfigured.dispose();
	const fake = fakeEngine();
	const selected: string[] = [];
	const originalStream = fake.engine.stream;
	fake.engine.stream = (text, options) => {
		selected.push(options.voice);
		return originalStream(text, options);
	};
	const speech = new KokoroSpeech({ load: async () => fake.engine });
	await speech.speak('Bonjour', { language: 'fr-FR' });
	await speech.speak('Bonsoir', { voice: 'ff_siwis' });
	assert.deepEqual(selected, ['ff_siwis', 'ff_siwis']);
	await assert.rejects(speech.speak('Bonjour', { voice: 'ff_siwis', language: 'en-US' }), /speaks/);
	await speech.dispose();
});

test('French normalization preserves nasal vowels, French r and punctuation', () => {
	assert.equal(normalizeFrenchPhonemes(' bɔ̃ʒˈuʁ lɛz ɑ̃fˈɑ̃ ! '), 'bɔ̃ʒˈuʁ lɛz ɑ̃fˈɑ̃ !');
	assert.equal(normalizeFrenchPhonemes('«d^ʒ-a^ɪ»'), '(ʤI)');
});

test('neural text segmentation preserves accented text and bounds long paragraphs', () => {
	const text = "L'été arrive bientôt. Où sont les enfants ? Ils jouent près de l'école !";
	assert.equal(splitSpeechText(text).join(' '), text);
	const chunks = splitSpeechText('bonjour '.repeat(150));
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((chunk) => chunk.length <= 200));
	assert.equal(chunks.join(' '), 'bonjour '.repeat(150).trim());
	assert.throws(() => splitSpeechText('a'.repeat(201)), /longer/);
});

test('failed downloads and failed lines can be retried without poisoning the queue', async () => {
	const fake = fakeEngine();
	let loads = 0;
	const speech = new KokoroSpeech({
		load: async () => {
			if (++loads === 1) throw new Error('download failed');
			return fake.engine;
		},
	});
	await assert.rejects(speech.ready(), /download/);
	await speech.ready();
	await assert.rejects(speech.speak('fail'), /inference/);
	await assert.rejects(speech.speak('fail'), /inference/);
	await speech.speak('Hello');
	assert.equal(loads, 2);
	assert.equal(fake.renders(), 3);
	await speech.dispose();
});

test('disposing during loading prevents queued inference and releases the loaded model', async () => {
	const fake = fakeEngine();
	let resolveLoad!: (engine: KokoroEngine) => void;
	const speech = new KokoroSpeech({
		load: () =>
			new Promise((resolve) => {
				resolveLoad = resolve;
			}),
	});
	const ready = speech.ready();
	const line = speech.speak('Hello');
	await Promise.resolve();
	const disposed = speech.dispose();
	resolveLoad(fake.engine);
	await ready;
	await assert.rejects(line, /disposed/);
	await disposed;
	assert.equal(fake.renders(), 0);
	assert.ok(fake.disposed());
	await assert.rejects(speech.speak('Hello'), /disposed/);
});

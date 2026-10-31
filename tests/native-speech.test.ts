import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSpeech } from '../src/speech/BrowserSpeech.ts';
import { composeCue } from '../src/compose/composeCue.ts';

function harness(initial: SpeechSynthesisVoice[] = []) {
	let voices = initial;
	let canceled = 0;
	const utterances: SpeechSynthesisUtterance[] = [];
	const events = new EventTarget();
	const engine = {
		getVoices: () => voices,
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		speak: (utterance: SpeechSynthesisUtterance) => utterances.push(utterance),
		cancel: () => {
			canceled++;
		},
	} as unknown as SpeechSynthesis;
	const speech = new BrowserSpeech(engine, (text) => ({ text }) as SpeechSynthesisUtterance);
	return {
		speech,
		utterances,
		canceled: () => canceled,
		load(next: SpeechSynthesisVoice[]) {
			voices = next;
			events.dispatchEvent(new Event('voiceschanged'));
		},
	};
}

function voice(name: string, lang: string, localService = true): SpeechSynthesisVoice {
	return { name, voiceURI: name, lang, localService, default: false };
}

test('native speech waits for voices and selects an exact locale over another dialect', async () => {
	const h = harness();
	const ready = h.speech.ready();
	const french = voice('French', 'fr-FR');
	h.load([voice('English', 'en-US'), voice('Canadian', 'fr-CA'), french]);
	assert.equal((await ready).length, 3);
	const done = h.speech.speak('Bonjour', { volume: 0.5 });
	assert.equal(h.utterances[0].voice, french);
	assert.equal(h.utterances[0].volume, 0.5);
	h.utterances[0].onend?.({} as SpeechSynthesisEvent);
	await done;
	assert.equal(h.utterances[0].onerror, null);
});

test('local-only speech rejects a remote voice instead of silently using it', async () => {
	const h = harness([voice('Remote', 'fr-FR', false)]);
	await assert.rejects(h.speech.speak('Bonjour', { localOnly: true }), /No local/);
	await assert.rejects(h.speech.speak('Bonjour', { voice: 'missing' }), /unavailable/);
	assert.equal(h.utterances.length, 0);
});

test('cancel settles every pending line even if the browser emits no cancellation events', async () => {
	const h = harness([voice('French', 'fr-FR')]);
	const first = h.speech.speak('Bonjour');
	const second = h.speech.speak('Au revoir');
	h.speech.cancel();
	await assert.rejects(first, /canceled/);
	await assert.rejects(second, /canceled/);
	assert.equal(h.canceled(), 1);
	h.speech.dispose();
	await assert.rejects(h.speech.speak('Bonjour'), /disposed/);
	assert.equal(h.canceled(), 1);
});

test('native playback failures reject and controls reject NaN', async () => {
	const h = harness();
	await assert.rejects(h.speech.speak('Bonjour', { rate: NaN }), /finite/);
	const done = h.speech.speak('Bonjour');
	h.utterances[0].onerror?.({ error: 'not-allowed' } as SpeechSynthesisErrorEvent);
	await assert.rejects(done, /not-allowed/);
});

test('composeCue accepts a prerecorded spoken line and preserves the supplied samples', () => {
	const samples = Float32Array.from({ length: 800 }, (_, i) => Math.sin(i * 0.1) * 0.5);
	const saved = samples.slice();
	const options = { style: 'dos-opl2-1987', seed: 'native', duration: 2, sampleRate: 8000, voiceSamples: samples };
	const cue = composeCue(options);
	assert.ok(cue.voiceTrack?.left.some((sample) => sample !== 0));
	assert.deepEqual(samples, saved);
	assert.equal(composeCue({ ...options, voice: 'none' }).voiceTrack, undefined);
});

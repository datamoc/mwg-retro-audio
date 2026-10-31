// npx tsx tools/render-neural-voice.ts [output-directory]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { composeCue } from '../src/compose/composeCue.ts';
import { encodeWav } from '../src/driver/Renderer.ts';
import { KokoroSpeech } from '../src/speech/KokoroSpeech.ts';

const directory = process.argv[2] ?? 'demo-output/neural-voice';
mkdirSync(directory, { recursive: true });
const text = 'Welcome to the village. Watch out, the guardian is coming!';
const speech = new KokoroSpeech();
const report = [];
try {
	const start = performance.now();
	await speech.ready();
	console.log(`Model ready in ${((performance.now() - start) / 1000).toFixed(2)} s`);
	for (const voice of ['af_heart', 'af_bella', 'am_michael', 'bf_emma', 'bm_george']) {
		const started = performance.now();
		const result = await speech.speak(text, { voice });
		const seconds = result.samples.length / result.sampleRate;
		const generationSeconds = (performance.now() - started) / 1000;
		if (!result.samples.length || result.samples.some((sample) => !Number.isFinite(sample)))
			throw new Error(`${voice}: invalid audio`);
		writeFileSync(join(directory, `${voice}.wav`), encodeWav(result.samples, result.samples, result.sampleRate));
		const cue = composeCue({
			style: 'disco-vocoder-1979',
			seed: 'native-voice',
			duration: 12,
			sampleRate: result.sampleRate,
			voiceSamples: result.samples,
		});
		writeFileSync(join(directory, `${voice}-vocoder.wav`), encodeWav(cue.left, cue.right, cue.sampleRate));
		report.push({ voice, text, seconds, generationSeconds, realtimeFactor: generationSeconds / seconds });
		console.log(`${voice}: ${seconds.toFixed(2)} s audio in ${generationSeconds.toFixed(2)} s`);
	}
	writeFileSync(join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
	await speech.dispose();
}

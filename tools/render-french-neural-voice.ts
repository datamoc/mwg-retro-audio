// npx tsx tools/render-french-neural-voice.ts [python-executable] [output-directory]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { composeCue } from '../src/compose/composeCue.ts';
import { encodeWav } from '../src/driver/Renderer.ts';
import { createFrenchPhonemizer } from '../src/node/frenchPhonemizer.ts';
import { KokoroSpeech } from '../src/speech/KokoroSpeech.ts';

const directory = process.argv[3] ?? 'demo-output/neural-voice';
mkdirSync(directory, { recursive: true });
const speech = new KokoroSpeech({ frenchPhonemize: createFrenchPhonemizer({ python: process.argv[2] }) });
const lines = [
	['ff_siwis', 'Bienvenue au village. Attention, le gardien approche !'],
	['ff_siwis-accents', "Les enfants jouent dans le jardin. Où sont les clés ? Elles sont près de l'entrée."],
	['ff_siwis-numbers', 'Nous sommes le 21 octobre. Vous avez gagné 125 pièces et trois étoiles.'],
] as const;
const report = [];
try {
	await speech.ready();
	for (const [name, text] of lines) {
		const start = performance.now();
		const result = await speech.speak(text, { language: 'fr-FR' });
		const generationSeconds = (performance.now() - start) / 1000;
		if (!result.samples.length || result.samples.some((sample) => !Number.isFinite(sample)))
			throw new Error(`${name}: invalid audio`);
		writeFileSync(join(directory, `${name}.wav`), encodeWav(result.samples, result.samples, result.sampleRate));
		if (name === 'ff_siwis') {
			const cue = composeCue({
				style: 'disco-vocoder-1979',
				seed: 'native-voice',
				duration: 12,
				sampleRate: result.sampleRate,
				voiceSamples: result.samples,
			});
			writeFileSync(join(directory, `${name}-vocoder.wav`), encodeWav(cue.left, cue.right, cue.sampleRate));
		}
		const seconds = result.samples.length / result.sampleRate;
		report.push({ name, text, seconds, generationSeconds });
		console.log(`${name}: ${seconds.toFixed(2)} s audio in ${generationSeconds.toFixed(2)} s`);
	}
	// Ensure the same loaded model still handles the original English path.
	const english = await speech.speak('Welcome to the village.', { voice: 'af_heart' });
	if (!english.samples.length) throw new Error('English regression: no samples');
	writeFileSync(join(directory, 'french-results.json'), JSON.stringify(report, null, 2) + '\n');
} finally {
	await speech.dispose();
}

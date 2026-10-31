// npx tsx tools/render-native-voice.ts [output-directory]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeCue } from '../src/compose/composeCue.ts';
import { encodeWav } from '../src/driver/Renderer.ts';
import { synthesizeWindowsSpeech } from '../src/node/windowsSpeech.ts';
import { synthesizeSpeech } from '../src/speech/speechRender.ts';

const directory = process.argv[2] ?? 'demo-output/native-voice';
mkdirSync(directory, { recursive: true });
for (const [language, text] of [
	['fr-FR', 'Bienvenue au village. Attention, le gardien approche !'],
	['en-US', 'Welcome to the village. Watch out, the guardian is coming!'],
] as const) {
	const native = await synthesizeWindowsSpeech(text, { language });
	const old = synthesizeSpeech({
		text,
		language: language === 'fr-FR' ? 'fr' : 'en',
		options: { sampleRate: native.sampleRate },
	});
	for (const [name, result] of [
		['native', native],
		['formant', old],
	] as const) {
		writeFileSync(
			join(directory, `${language}-${name}.wav`),
			encodeWav(result.samples, result.samples, result.sampleRate),
		);
	}
	const cue = composeCue({
		style: 'disco-vocoder-1979',
		seed: 'native-voice',
		duration: 12,
		sampleRate: native.sampleRate,
		voiceSamples: native.samples,
	});
	writeFileSync(join(directory, `${language}-vocoder.wav`), encodeWav(cue.left, cue.right, cue.sampleRate));
	console.log(
		`${language}: ${native.samples.length / native.sampleRate} s at ${native.sampleRate} Hz → ${directory}`,
	);
}

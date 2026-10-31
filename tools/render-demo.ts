// Usage: npx tsx tools/render-demo.ts [outputDir]
// Renders the demo set at 48 kHz (WAV, then Opus through ffmpeg): two ~60 s cues with a spoken line and its dry voice
// stem, a pack of game moods, and two a cappella nursery rhymes. Prints how each cue measures against its style profile
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCue, composeCue } from '../src/compose/index.ts';
import { encodeWav } from '../src/driver/Renderer.ts';
import { singLyrics } from '../src/speech/index.ts';
import { ENGLISH_SYLLABLES, FRENCH_SYLLABLES, melody } from './songs.ts';

const RATE = 48000;
const outputDir = process.argv[2] ?? 'demo-output';
mkdirSync(outputDir, { recursive: true });

/** write a WAV, encode it to Opus (192 kbps: transparent for this material), return whether ffmpeg succeeded */
function save(file: string, left: Float32Array, right: Float32Array): boolean {
	const wav = join(outputDir, `${file}.wav`);
	writeFileSync(wav, encodeWav(left, right, RATE));
	const encoded = spawnSync(
		'ffmpeg',
		['-v', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '192k', join(outputDir, `${file}.opus`)],
		{ stdio: 'inherit' },
	);
	return encoded.status === 0;
}

function normalise(x: Float32Array, level: number): Float32Array {
	let top = 0;
	for (const v of x) top = Math.max(top, Math.abs(v));
	return top > 0 ? x.map((v) => (v * level) / top) : x;
}

const demos = [
	{
		file: 'demo-disco-vocoder',
		style: 'disco-vocoder-1979',
		seed: 'demo-1',
		duration: 60,
		text: 'bienvenue au club, ce soir on danse',
	},
	{
		file: 'demo-dos-opl2',
		style: 'dos-opl2-1987',
		seed: 'demo-2',
		duration: 60,
		text: 'niveau un, prépare toi au combat',
	},
	// a pack of moods for a game, on the DOS style, each with a short spoken line
	...Object.entries({
		forest: 'la forêt est calme',
		dungeon: 'attention, danger',
		village: 'bienvenue au village',
		fight: "à l'attaque",
		boss: 'le gardien approche',
		victory: 'victoire',
	}).map(([scene, text]) => ({
		file: `scene-${scene}`,
		style: 'dos-opl2-1987',
		seed: `scene-${scene}`,
		duration: 30,
		scene,
		text,
	})),
] as const;

for (const demo of demos) {
	const cue = composeCue({
		style: demo.style,
		seed: demo.seed,
		duration: demo.duration,
		sampleRate: RATE,
		scene: 'scene' in demo ? demo.scene : undefined,
		text: demo.text,
	});
	const check = checkCue(cue);
	let opus = save(demo.file, cue.left, cue.right);
	// the dry voice alone, to filter or mix again
	if (cue.voiceTrack && !demo.file.startsWith('scene-'))
		opus =
			save(`${demo.file}-voice`, normalise(cue.voiceTrack.left, 0.85), normalise(cue.voiceTrack.right, 0.85)) &&
			opus;
	console.log(
		`${demo.file}: ${cue.seconds.toFixed(2)} s, ${cue.bars} bars @ ${cue.tempo} BPM | tempo error ${(100 * check.tempoError).toFixed(2)} %` +
			` | scale share ${check.scaleShare.toFixed(3)} | centroid ${check.centroid.toFixed(0)} Hz | ${check.ok ? 'matches the style' : 'OUT OF PROFILE'}` +
			` | opus ${opus ? 'ok' : 'failed'}`,
	);
}

// a cappella: one melody, a French and an English text, a voice with a little vibrato doubled with a chorus
const songs = [
	{ file: 'acappella-fr-ah-vous-dirai-je-maman', syllables: FRENCH_SYLLABLES, language: 'fr' },
	{ file: 'acappella-en-twinkle-twinkle', syllables: ENGLISH_SYLLABLES, language: 'en' },
] as const;
for (const song of songs) {
	const voice = normalise(
		singLyrics(song.syllables, melody(96), song.language, {
			sampleRate: RATE,
			source: 'glottal',
			formantScale: 1.15,
			chorus: 3,
		}),
		0.85,
	);
	const ok = save(song.file, voice, voice);
	console.log(
		`${song.file}: ${(voice.length / RATE).toFixed(2)} s, ${song.syllables.length} syllables | opus ${ok ? 'ok' : 'failed'}`,
	);
}

// Usage: npx tsx tools/encode-opus.ts <input.wav> <output.opus> [kbps]
// Node has no WebCodecs: encode a WAV rendering to Ogg Opus with the libopus of an installed ffmpeg
import { spawnSync } from 'node:child_process';

const [input, output, kbps] = process.argv.slice(2);
if (!input || !output) {
	console.error('usage: encode-opus.ts <input.wav> <output.opus> [kbps]');
	process.exit(2);
}
const result = spawnSync(
	'ffmpeg',
	['-v', 'error', '-y', '-i', input, '-c:a', 'libopus', '-b:a', `${kbps ?? 128}k`, output],
	{ stdio: 'inherit' },
);
process.exit(result.status ?? 1);

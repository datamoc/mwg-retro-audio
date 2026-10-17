/**
 * Command line:
 *   node src/cli.ts render <hatari-trace.txt> <out.wav>
 * The trace is produced with:  hatari --trace psg_write,video_vbl --trace-file trace.txt ...
 */
import { readTrace } from './trace.ts';
import { renderTrace } from './render.ts';
import { writeWav } from './wav.ts';

const [cmd, input, output] = process.argv.slice(2);
if (cmd !== 'render' || !input || !output) {
	console.error('usage: node src/cli.ts render <hatari-trace.txt> <out.wav>');
	process.exit(2);
}
const trace = await readTrace(input);
const pcm = renderTrace(trace);
writeWav(output, pcm);
console.log(`${trace.events.length} YM writes, ${trace.frameStart.length - 1} VBL -> ${pcm.length} samples (${(pcm.length / 44100).toFixed(2)} s) in ${output}`);

/**
 * Render the Airball recordings as an NTSC STF would play them: same program events at the same wall-clock times
 * (the driver is clocked by the MFP crystal), YM clock = NTSC CPU / 4.
 *   node scripts/render-ntsc.ts <trace.txt> <out.wav> <startSeconds> <durationSeconds>
 */
import { readTrace } from '../src/trace.ts';
import { renderTrace } from '../src/render.ts';
import { writeWav } from '../src/wav.ts';

const [tracePath, out, start, dur] = process.argv.slice(2);
const trace = await readTrace(tracePath);
const pcm = renderTrace(trace, { machine: 'stf-ntsc', traceCpuFreq: 8021247 });
const a = Math.floor(Number(start) * 44100), n = Math.round(Number(dur) * 44100);
writeWav(out, pcm.subarray(a, a + n));
console.log(out, (n / 44100).toFixed(2), 's');

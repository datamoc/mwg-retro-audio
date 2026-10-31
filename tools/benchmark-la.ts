/** Run with: node --import tsx tools/benchmark-la.ts [--quick]
 *  44.1 kHz stereo, 128-frame blocks, median of seven runs after two warmups.
 *  Construction and note-on are excluded. Hashes allow PCM comparisons between revisions.
 *  CPU time includes buffer copies; --quick uses 0.25 seconds and three measured runs.
 */
import { createHash } from 'node:crypto';
import type { Chip } from '../src/chips/Chip.ts';
import { D50Synth, D50_PRESETS } from '../src/chips/historical.ts';
import { Mt32Synth } from '../src/chips/Mt32Synth.ts';
import { D50_WAVE_ATTACKS } from '../src/chips/d50Waves.ts';

const rate = 44100;
const blockSize = 128;
const quick = process.argv.includes('--quick');
const measuredRuns = quick ? 3 : 7;
const blockCount = Math.ceil((rate * (quick ? 0.25 : 1)) / blockSize);
const durationMs = (blockCount * blockSize * 1000) / rate;

function benchmark(name: string, make: () => Chip): void {
	const timings: number[] = [];
	const cpuTimings: number[] = [];
	let hash = '';
	for (let run = 0; run < measuredRuns + 2; run++) {
		const synth = make();
		const left = new Float32Array(blockSize);
		const right = new Float32Array(blockSize);
		const pcm = new Float32Array(blockCount * blockSize * 2);
		let elapsed = 0;
		const cpuStart = process.cpuUsage();
		for (let block = 0; block < blockCount; block++) {
			left.fill(0);
			right.fill(0);
			const start = performance.now();
			synth.render(left, right, 0, blockSize);
			elapsed += performance.now() - start;
			pcm.set(left, block * blockSize * 2);
			pcm.set(right, block * blockSize * 2 + blockSize);
		}
		const cpu = process.cpuUsage(cpuStart);
		if (run >= 2) {
			timings.push(elapsed);
			cpuTimings.push((cpu.user + cpu.system) / 1000);
		}
		hash = createHash('sha256').update(new Uint8Array(pcm.buffer)).digest('hex');
	}
	timings.sort((a, b) => a - b);
	cpuTimings.sort((a, b) => a - b);
	const ms = timings[Math.floor(timings.length / 2)];
	const cpuMs = cpuTimings[Math.floor(cpuTimings.length / 2)];
	console.log(
		`${name}: ${ms.toFixed(2)} ms wall, ${cpuMs.toFixed(2)} ms CPU, ${((ms / durationMs) * 100).toFixed(1)}% of audio duration; sha256=${hash}`,
	);
}

// SysEx patches use fitted recipes rather than entries in the generic attack bank.
const noteOnTimings: number[] = [];
for (let run = 0; run < measuredRuns + 2; run++) {
	const synth = new D50Synth({ sampleRate: rate });
	synth.loadPatch({
		tones: [
			{
				partials: [
					{
						wave: 'attack',
						recipe: D50_WAVE_ATTACKS[0],
						cutoff: 8000,
						amp: [
							[0, 1],
							[0.1, 0],
						],
					},
				],
			},
		],
	});
	const start = performance.now();
	for (let note = 48; note < 64; note++) synth.noteOn(note, 100);
	if (run >= 2) noteOnTimings.push(performance.now() - start);
}
noteOnTimings.sort((a, b) => a - b);
console.log(
	`D-50 / SysEx attack / 16 note-ons (warm samples): ${noteOnTimings[Math.floor(noteOnTimings.length / 2)].toFixed(2)} ms`,
);

for (let preset = 0; preset < D50_PRESETS.length; preset++) {
	benchmark(`D-50 / ${D50_PRESETS[preset].name} / 16 voices`, () => {
		const synth = new D50Synth({ sampleRate: rate });
		synth.selectPreset(preset);
		for (let note = 48; note < 64; note++) synth.noteOn(note, 100);
		return synth;
	});
}

benchmark('MT-32 / idle', () => new Mt32Synth(rate));
for (const parts of [1, 8]) {
	benchmark(`MT-32 / 16 notes across ${parts} parts`, () => {
		const synth = new Mt32Synth(rate);
		for (let i = 0; i < 16; i++) synth.midi(0x91 + (i % parts), 48 + i, 100);
		return synth;
	});
}

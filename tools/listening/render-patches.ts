// Builds a listening set for the A/B protocol: picks a few D-50 patches per family from a folder of `.syx` banks, renders
// each one to a WAV (a single note, then a chord, then silence for the release) and writes a `verdicts.csv` to fill in.
//
//   node --import tsx tools/listening/render-patches.ts <folder with .syx/.d50> <output folder> [perFamily=3] [formats=wav]
//
// `formats` is a comma separated list of wav, flac, opus (Opus needs ffmpeg here: Node has no WebCodecs).
//
// The output goes where the caller says (the git-ignored `download/` is a good place): the patches belong to their
// authors and the renders are the engine's own interpretation of them, so neither is part of the package.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { D50Synth } from '../../src/chips/historical.ts';
import { exportAudio, type AudioFormat } from '../../src/driver/export.ts';
import { spawnSync } from 'node:child_process';
import { D50_PCM_NAMES, parseD50SysEx, readD50Memory } from '../../src/formats/d50.ts';

const [corpus, out, perFamilyArg, formatsArg] = process.argv.slice(2);
if (!corpus || !out) throw new Error('usage: render-patches.ts <folder with .syx/.d50> <output folder> [perFamily]');
const perFamily = Number(perFamilyArg ?? 3);
const formats = (formatsArg ?? 'wav').split(',').map((f) => f.trim()) as AudioFormat[];
const RATE = 44100;

const FAMILIES: Record<string, RegExp> = {
	piano: /\bpiano\b|\bpf\b|grand/i,
	epiano: /e\.?piano|rhodes|\bep\b/i,
	strings: /string|violin|cello|orchestra/i,
	brass: /brass|trumpet|trombone|horn/i,
	bass: /\bbass\b/i,
	pad: /\bpad\b|atmos|space|dream/i,
	flute: /flute|pan ?pipe|breath|wind/i,
	bell: /bell|chime|glass|vibe|marimba|xylo/i,
	organ: /organ/i,
	lead: /\blead\b|solo/i,
	choir: /choir|voice|vox|aah|ooh/i,
	guitar: /guitar|gtr|pluck|harp/i,
	pcm: /pcm|spect|loop/i,
};

const files: string[] = [];
const walk = (dir: string): void => {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p);
		else if (/\.(syx|d50)$/i.test(f)) files.push(p);
	}
};
walk(corpus);
files.sort();

interface Candidate {
	name: string;
	toneNames: string[];
	file: string;
	slot: number | undefined;
	source: string;
	waves: string[];
	structure: number;
	patch: ReturnType<typeof parseD50SysEx>[number]['patch'];
}

const seen = new Set<string>();
const byFamily = new Map<string, Candidate[]>();
for (const file of files) {
	const bytes = new Uint8Array(readFileSync(file));
	const memory = readD50Memory(bytes);
	for (const p of parseD50SysEx(bytes)) {
		const label = `${p.name} ${p.toneNames.join(' ')}`;
		if (!p.name.trim()) continue;
		const key = `${p.name}|${p.toneNames.join('|')}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const base = p.source === 'temporary' ? 0 : (2 << 14) + (p.slot! - 1) * 448;
		const waves: string[] = [];
		for (let t = 0; t < 2; t++) {
			const tb = base + t * 192;
			const structure = (memory.get(tb + 128 + 0x0a) ?? 0) + 1;
			const pcm = [[], [], [0], [0], [1], [0, 1], [0, 1]][structure - 1] ?? [];
			for (const pi of pcm) {
				const w = memory.get(tb + pi * 64 + 7);
				if (w !== undefined && D50_PCM_NAMES[w]) waves.push(D50_PCM_NAMES[w]);
			}
		}
		const cand: Candidate = {
			name: p.name.trim(),
			toneNames: p.toneNames,
			file,
			slot: p.slot,
			source: p.source,
			waves: [...new Set(waves)],
			structure: p.patch.tones[0].structure ?? 1,
			patch: p.patch,
		};
		for (const [family, re] of Object.entries(FAMILIES)) {
			if (!re.test(label)) continue;
			const list = byFamily.get(family) ?? [];
			list.push(cand);
			byFamily.set(family, list);
		}
	}
}

mkdirSync(out, { recursive: true });
const rows = ['file,family,patch,tones,source,slot,structure,pcm waves,verdict (ok / faux / muet),comment'];
const chosen = new Set<string>();
let count = 0;
for (const [family, list] of byFamily) {
	// deterministic spread over the sorted candidates rather than the first few, so banks are mixed
	const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
	const picks: Candidate[] = [];
	for (let i = 0; i < perFamily && i < sorted.length; i++)
		picks.push(sorted[Math.floor(((i + 0.5) * sorted.length) / Math.min(perFamily, sorted.length))]);
	for (const c of picks) {
		const id = `${c.name}|${c.toneNames.join('|')}`;
		if (chosen.has(id)) continue;
		chosen.add(id);
		const synth = new D50Synth({ sampleRate: RATE });
		synth.loadPatch(c.patch);
		const seg = (seconds: number, on: number[], off: number[] = []): [Float32Array, Float32Array] => {
			for (const n of off) synth.noteOff(n);
			for (const n of on) synth.noteOn(n, 100);
			const n = Math.floor(seconds * RATE);
			const l = new Float32Array(n);
			const r = new Float32Array(n);
			synth.render(l, r, 0, n);
			return [l, r];
		};
		const parts = [seg(2.5, [60]), seg(0.3, [], [60]), seg(3, [48, 60, 64, 67]), seg(1.5, [], [48, 60, 64, 67])];
		const total = parts.reduce((s, [l]) => s + l.length, 0);
		const left = new Float32Array(total);
		const right = new Float32Array(total);
		let o = 0;
		for (const [l, r] of parts) {
			left.set(l, o);
			right.set(r, o);
			o += l.length;
		}
		let peak = 0;
		for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
		const gain = peak > 0 ? 0.8 / peak : 1; // normalised: the listening compares timbres, not levels
		for (let i = 0; i < total; i++) {
			left[i] *= gain;
			right[i] *= gain;
		}
		const safe =
			c.name
				.replace(/[^A-Za-z0-9]+/g, '_')
				.replace(/^_|_$/g, '')
				.slice(0, 40) || 'patch';
		const file = `${family}_${String(++count).padStart(2, '0')}_${safe}.wav`;
		const tags = { title: c.name, comment: `D-50 model, ${family}` };
		for (const format of formats) {
			const name = file.replace(/\.wav$/, `.${format}`);
			if (format === 'opus') {
				// Node has no WebCodecs: encode the WAV with ffmpeg when it is installed
				const wav = join(out, file.replace(/\.wav$/, '.tmp.wav'));
				writeFileSync(wav, await exportAudio({ sampleRate: RATE, left, right }, 'wav'));
				const r = spawnSync('ffmpeg', [
					'-v',
					'error',
					'-y',
					'-i',
					wav,
					'-c:a',
					'libopus',
					'-b:a',
					'128k',
					join(out, name),
				]);
				if (r.status !== 0)
					console.warn(`no Opus for ${file}: ffmpeg is needed (${String(r.stderr || r.error).trim()})`);
				rmSync(wav, { force: true });
			} else
				writeFileSync(join(out, name), await exportAudio({ sampleRate: RATE, left, right }, format, { tags }));
		}
		const csv = (s: string): string => `"${s.replace(/"/g, '""')}"`;
		rows.push(
			[
				formats.map((f) => file.replace(/\.wav$/, `.${f}`)).join(' '),
				family,
				csv(c.name),
				csv(c.toneNames.join(' / ')),
				c.source,
				c.slot ?? '',
				c.structure,
				csv(c.waves.join(', ')),
				'',
				'',
			].join(','),
		);
	}
}
writeFileSync(join(out, 'verdicts.csv'), rows.join('\n') + '\n');
console.log(`${count} patches rendered to ${out} (families: ${[...byFamily.keys()].join(', ')}); fill in verdicts.csv`);

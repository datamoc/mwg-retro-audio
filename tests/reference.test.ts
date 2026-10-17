import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { compareAudio, compareSpectra } from '../src/driver/Compare.ts';
import { Ym2149 } from '../src/chips/Ym2149.ts';
import { MwaRecorder } from '../src/formats/index.ts';
import { SfxEngine, importSfx, renderSfx, type SfxDefinition } from '../src/sfx/index.ts';
import { Region } from '../src/region.ts';
import { RATE } from './util.ts';

test('compareAudio measures the relative error, finds a constant delay and honours the tolerance', () => {
	const ref = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 7));
	const late = Float32Array.from({ length: 4000 }, (_, i) => Math.sin((i - 3) / 7));
	const same = compareAudio(ref, ref);
	assert.equal(same.relativeError, 0);
	assert.ok(compareAudio(late, ref).relativeError > 0.2);
	const aligned = compareAudio(late, ref, { maxLag: 8 });
	assert.equal(aligned.lag, 3, 'the delayed copy is 3 samples late');
	assert.ok(aligned.ok && aligned.relativeError < 1e-2);
	const noisy = ref.map((v, i) => v + (i % 2 ? 0.3 : -0.3));
	assert.ok(!compareAudio(noisy, ref, { tolerance: 0.05 }).ok);
});

const hatari = new URL('../vendor/hatari-ym/src/ym2149.ts', import.meta.url);

test('the YM2149 of this engine against the bit-exact Hatari chain (reference): the same register program, explicit tolerance', async (t) => {
	if (!existsSync(hatari)) return t.skip('vendor/hatari-ym is missing');
	const { HatariYm } = (await import(hatari.href)) as typeof import('../vendor/hatari-ym/src/ym2149.ts');
	const rate = 44100;
	const program = (w: (reg: number, v: number) => void, frame: number): void => {
		// three voices, a slow arpeggio and a volume decay: register writes once per 50 Hz frame
		const notes = [100, 126, 150];
		for (let c = 0; c < 3; c++) {
			const period = Math.round(notes[(frame + c) % 3] * (1 + c * 0.5));
			w(c * 2, period & 255);
			w(c * 2 + 1, period >> 8);
			w(8 + c, Math.max(1, 15 - (frame % 16)));
		}
		w(7, 0b111000);
	};
	const frames = 100;
	const ref = new HatariYm({ machine: 'stf-pal', sampleRate: rate });
	const start = Math.round(ref.cpuFreq * 0.5);
	ref.reset(0);
	const at = (f: number): number => start + Math.round((f * ref.cpuFreq) / 50);
	for (let f = 0; f < frames; f++) program((r, v) => ref.writeData(at(f), r, v), f);
	ref.update(at(frames));
	// Hatari starts counting at clock 0 and the program at half a second: drop that silent lead-in
	const reference = Float32Array.from(ref.takeSamples(), (v) => v / 32768).subarray(Math.round(rate / 2));

	const mine = new Ym2149({ sampleRate: rate, clock: 2_005_311, atariStOutput: true });
	const out = new Float32Array(Math.floor((frames * rate) / 50));
	const sink = new Float32Array(out.length);
	for (let f = 0; f < frames; f++) {
		program((r, v) => mine.write(r, v), f);
		const a = Math.floor((f * rate) / 50);
		const b = Math.floor(((f + 1) * rate) / 50);
		mine.render(out, sink, a, b - a);
	}
	// the oscillator phases of two emulations are free, so the comparison is spectral: where the energy lies and how much
	const pitch = compareSpectra(out.subarray(4000, out.length - 4000), reference.subarray(4000, out.length - 4000));
	console.log(
		`YM2149 vs Hatari: mean spectral difference ${pitch.meanDb.toFixed(1)} dB, ${(pitch.agreement * 100).toFixed(0)} % of the strong bins agree within 6 dB`,
	);
	assert.ok(pitch.agreement > 0.5, `only ${(pitch.agreement * 100).toFixed(0)} % of the strong bins agree`);
	assert.ok(pitch.meanDb < 12, `mean difference ${pitch.meanDb} dB`);
});

test('an effect recorded with the register recorder and imported plays back within 2 percent for the SID too', () => {
	const def: SfxDefinition = {
		name: 'sidfx',
		chip: 'sid',
		priority: 5,
		retrigger: 'restart',
		length: 25,
		voices: [
			{
				channel: 0,
				pitch: { start: 84, step: -1, min: 40 },
				volume: { start: 15, step: -0.6, min: 0 },
				waveform: 0x20,
			},
		],
	};
	const original = renderSfx(def, 0.6, { sampleRate: RATE, region: Region.PAL });
	const rec = new MwaRecorder();
	const engine = new SfxEngine({ region: Region.PAL, sampleRate: RATE });
	const guard = engine.attach(rec.factory('sid', { sampleRate: RATE, clock: 985_248 }));
	engine.define(def);
	engine.play('sidfx');
	const l = new Float32Array(Math.floor(0.6 * RATE));
	guard.render(l, new Float32Array(l.length), 0, l.length);
	const imported = importSfx(rec.finish({ frameRate: 50 }), { name: 'sidfx' });
	assert.equal(imported.chip, 'sid');
	const again = renderSfx(imported, 0.6, { sampleRate: RATE, region: Region.PAL });
	const cmp = compareAudio(again.left, original.left, { tolerance: 0.15 });
	assert.ok(cmp.ok, `SID round trip error ${cmp.relativeError}`);
});

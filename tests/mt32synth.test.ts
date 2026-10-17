import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mt32Synth } from '../src/chips/Mt32Synth.ts';
import { loadMidiMt32 } from '../src/formats/midi.ts';
import { renderPlayer } from '../src/driver/Renderer.ts';
import { Mt32Memory, Mt32Session, buildRolandDt1, MODEL_MT32 } from '../src/formats/roland.ts';
import { frequency, peak, RATE, rms } from './util.ts';

const render = (s: Mt32Synth, seconds: number): Float32Array => {
	const n = Math.floor(seconds * RATE);
	const l = new Float32Array(n);
	const r = new Float32Array(n);
	s.render(l, r, 0, n);
	return l;
};

test('Mt32Synth: a note on MIDI channel 2 (part 1) sounds at the right pitch through the LaRomProvider socket', () => {
	const synth = new Mt32Synth(RATE);
	synth.part(1).loadPatch({
		tones: [
			{
				structure: 1,
				partials: [
					{
						wave: 'saw',
						cutoff: 12000,
						amp: [
							[0, 1],
							[1, 1],
						],
					},
				],
			},
		],
		release: 0.05,
	});
	const session = new Mt32Session();
	session.attach(synth);
	assert.equal(session.approximate, false);
	synth.midi(0x91, 69, 120);
	const out = render(synth, 1);
	assert.ok(Math.abs(frequency(out, RATE, RATE / 4) - 440) < 2);
	synth.midi(0x81, 69, 0);
	const tail = render(synth, 0.6);
	assert.ok(rms(tail, tail.length - 4000) < 1e-4, 'released');
});

test('Mt32Synth: program change picks a preset by family, rhythm channel plays attacks, SysEx are accepted', () => {
	const synth = new Mt32Synth(RATE);
	synth.midi(0xc2, 40, 0); // strings family on part 2
	synth.midi(0x92, 60, 100);
	assert.ok(peak(render(synth, 0.5)) > 0.01);
	synth.midi(0xb2, 123, 0); // all notes off
	const drums = new Mt32Synth(RATE);
	drums.midi(0x99, 38, 110);
	assert.ok(rms(render(drums, 0.3), 0, 2000) > 0.001, 'rhythm part makes a transient');
	const session = new Mt32Session();
	session.attach(synth);
	assert.ok(
		session.receive(
			buildRolandDt1(
				MODEL_MT32,
				0x10,
				Mt32Memory.display,
				[...'Hello'].map((c) => c.charCodeAt(0)),
			),
		),
	);
	assert.equal(session.lcd, 'Hello');
});

test('loadMidiMt32: an MT-32 song (note on MIDI channel 2) plays through the ROM-free LA model to its end', () => {
	const track = [
		0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xc1, 48, 0, 0x91, 69, 100, 96, 0x81, 69, 0, 0, 0xff, 0x2f, 0,
	];
	const bytes = Uint8Array.from([
		0x4d,
		0x54,
		0x68,
		0x64,
		0,
		0,
		0,
		6,
		0,
		0,
		0,
		1,
		0,
		96,
		0x4d,
		0x54,
		0x72,
		0x6b,
		0,
		0,
		0,
		track.length,
		...track,
	]);
	const player = loadMidiMt32(bytes, { sampleRate: RATE });
	assert.deepEqual(player.info.chips, ['mt32']);
	const out = renderPlayer(player, { maxSeconds: 5 });
	assert.ok(out.ended && peak(out.left) > 0.01);
	// the strings family (program 48) on part 2: energy at the played pitch or one of its harmonics
	const body = out.left.subarray(4000, Math.floor(RATE * 0.45));
	const power = (f: number): number => {
		let re = 0;
		let im = 0;
		for (let i = 0; i < body.length; i++) {
			re += body[i] * Math.cos((2 * Math.PI * f * i) / RATE);
			im += body[i] * Math.sin((2 * Math.PI * f * i) / RATE);
		}
		return re * re + im * im;
	};
	assert.ok(power(440) > power(311) * 4, 'A4 is stronger than a note a fourth below');
});

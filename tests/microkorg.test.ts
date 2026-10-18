import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicroKorgSynth, MICROKORG_PROGRAMS } from '../src/chips/MicroKorg.ts';
import type { MicroKorgProgram } from '../src/chips/MicroKorg.ts';
import { instrumentCatalogue } from '../src/instruments/catalogue.ts';

const RATE = 44100;

function render(synth: MicroKorgSynth, seconds: number): Float32Array {
	const left = new Float32Array(Math.round(RATE * seconds));
	synth.render(left, new Float32Array(left.length), 0, left.length);
	return left;
}

/** a program with the filter wide open and no movement anywhere, from a factory program: tests change one thing */
function open(change: (program: MicroKorgProgram) => void = () => {}): MicroKorgProgram {
	const program = structuredClone(MICROKORG_PROGRAMS[0].program);
	program.osc1 = { wave: 'saw', pulseWidth: 0.5, octave: 0, level: 1 };
	program.osc2 = { wave: 'saw', semitone: 0, fine: 0, level: 0, sweep: 0 };
	program.sync = 'off';
	program.sub = 0;
	program.noise = 0;
	program.filter = { type: 'lp12', cutoff: 20000, resonance: 0, envAmount: 0, keyTrack: 0 };
	program.ampEnv = { attack: 0.001, decay: 0.1, sustain: 1, release: 0.1 };
	program.filterEnv = { attack: 0.001, decay: 0.1, sustain: 1, release: 0.1 };
	program.lfo = { wave: 'triangle', rate: 5, pitchCents: 0, cutoffOctaves: 0, amp: 0, pulseWidth: 0, delay: 0 };
	program.velocitySens = 0;
	change(program);
	return program;
}

function play(program: MicroKorgProgram, note: number, seconds: number): Float32Array {
	const synth = new MicroKorgSynth({ sampleRate: RATE });
	synth.loadProgram(program);
	synth.noteOn(note, 127);
	return render(synth, seconds);
}

/** the strength of one frequency in a signal (Goertzel) */
function magnitude(signal: Float32Array, hz: number): number {
	const w = (2 * Math.PI * hz) / RATE;
	let re = 0;
	let im = 0;
	for (let i = 0; i < signal.length; i++) {
		re += signal[i] * Math.cos(w * i);
		im += signal[i] * Math.sin(w * i);
	}
	return Math.hypot(re, im) / signal.length;
}

const energy = (signal: Float32Array, from = 0): number =>
	signal.slice(from).reduce((sum, value) => sum + value * value, 0);
/** the energy of the signal's slope: it weighs the high frequencies, where a low-pass filter acts */
const brightness = (signal: Float32Array, from = 0): number => {
	let sum = 0;
	for (let i = from + 1; i < signal.length; i++) sum += (signal[i] - signal[i - 1]) ** 2;
	return sum;
};
const settled = (signal: Float32Array): Float32Array => signal.subarray(Math.round(RATE * 0.1));

test('every program makes bounded, finite, non silent sound at several pitches', () => {
	assert.equal(MICROKORG_PROGRAMS.length, 15);
	for (const { name, program } of MICROKORG_PROGRAMS) {
		for (const note of [36, 60, 84]) {
			const sound = play(structuredClone(program), note, 0.6);
			assert(
				sound.every((value) => Number.isFinite(value) && Math.abs(value) < 1.2),
				`${name} @${note} is out of range`,
			);
			assert(
				sound.some((value) => Math.abs(value) > 1e-3),
				`${name} @${note} is silent`,
			);
		}
	}
});

test('the oscillators play in tune', () => {
	for (const wave of ['saw', 'square', 'triangle', 'sine'] as const) {
		const body = settled(
			play(
				open((p) => (p.osc1.wave = wave)),
				69,
				0.5,
			),
		);
		const at440 = magnitude(body, 440);
		for (const wrong of [415, 466, 330, 220])
			assert(at440 > magnitude(body, wrong) * 3, `${wave}: 440 Hz against ${wrong} Hz`);
		assert(at440 > magnitude(body, 880), `${wave}: the fundamental is the strongest`);
	}
});

test('oscillator 2 follows its semitone', () => {
	const body = settled(
		play(
			open((p) => {
				p.osc1.level = 0;
				p.osc2 = { wave: 'triangle', semitone: 12, fine: 0, level: 1, sweep: 0 };
			}),
			57,
			0.5,
		),
	);
	assert(magnitude(body, 440) > magnitude(body, 220) * 3);
	assert(magnitude(body, 440) > magnitude(body, 466) * 3);
});

test('the filter closes the sound as its cut-off falls and each type keeps its band', () => {
	const bright = brightness(play(open(), 48, 0.5), 8000);
	const dark = brightness(
		play(
			open((p) => (p.filter.cutoff = 400)),
			48,
			0.5,
		),
		8000,
	);
	assert(dark < bright * 0.05, `low-pass: ${dark} against ${bright}`);
	const tenth = (type: 'lp12' | 'lp24'): number =>
		magnitude(
			settled(
				play(
					open((p) => {
						p.filter.type = type;
						p.filter.cutoff = 600;
					}),
					48,
					0.5,
				),
			),
			130.8128 * 10,
		);
	assert(tenth('lp24') < tenth('lp12') * 0.5, '24 dB closes faster than 12 dB');
	const high = play(
		open((p) => {
			p.filter.type = 'hp12';
			p.filter.cutoff = 3000;
		}),
		36,
		0.5,
	);
	assert(magnitude(high, 65.4) < magnitude(play(open(), 36, 0.5), 65.4) * 0.1, 'high-pass removes the fundamental');
	const band = play(
		open((p) => {
			p.filter.type = 'bp12';
			p.filter.cutoff = 1000;
			p.filter.resonance = 0.6;
		}),
		48,
		0.5,
	);
	assert(energy(band) > 0 && energy(band) < energy(play(open(), 48, 0.5)));
});

test('resonance raises the sound at the cut-off', () => {
	const at = (resonance: number): number =>
		magnitude(
			play(
				open((p) => {
					p.filter.cutoff = 880;
					p.filter.resonance = resonance;
				}),
				45,
				0.5,
			).subarray(4000),
			880,
		);
	assert(at(0.9) > at(0) * 1.5);
});

test('ring modulation leaves the sum and the difference of the two frequencies, not the originals', () => {
	const make = (sync: 'off' | 'ring'): Float32Array =>
		settled(
			play(
				open((p) => {
					// the ring product replaces the dry oscillator 1 here, so that only the product is heard
					p.osc1 = { wave: 'sine', pulseWidth: 0.5, octave: 0, level: sync === 'ring' ? 0 : 1 };
					p.osc2 = { wave: 'triangle', semitone: 7, fine: 0, level: 1, sweep: 0 };
					p.sync = sync;
				}),
				69,
				0.6,
			),
		);
	const product = make('ring');
	const plain = make('off');
	const f2 = 440 * 2 ** (7 / 12);
	assert(magnitude(product, 440) < magnitude(plain, 440) * 0.2, 'the fundamental is gone');
	assert(magnitude(product, f2 - 440) > magnitude(plain, f2 - 440) * 3, 'the difference tone appears');
});

test('hard sync makes oscillator 2 repeat at the pitch of oscillator 1', () => {
	const make = (sync: 'off' | 'sync'): Float32Array =>
		play(
			open((p) => {
				p.osc1.level = 0.5;
				p.osc2 = { wave: 'saw', semitone: 9, fine: 0, level: 0.5, sweep: 0 };
				p.sync = sync;
			}),
			45,
			0.6,
		);
	const period = RATE / 110;
	const correlation = (signal: Float32Array): number => {
		let best = 0;
		for (let lag = Math.floor(period) - 2; lag <= Math.ceil(period) + 2; lag++) {
			let sum = 0;
			let norm = 0;
			for (let i = 8000; i < 20000; i++) {
				sum += signal[i] * signal[i + lag];
				norm += signal[i] * signal[i];
			}
			best = Math.max(best, sum / norm);
		}
		return best;
	};
	assert(correlation(make('sync')) > 0.97, `synced: ${correlation(make('sync'))}`);
	assert(correlation(make('off')) < 0.9, `free running: ${correlation(make('off'))}`);
});

test('the envelopes shape a note and the voices are freed after the release', () => {
	const synth = new MicroKorgSynth({ sampleRate: RATE });
	synth.loadProgram(open((p) => (p.ampEnv = { attack: 0.2, decay: 0.2, sustain: 0.5, release: 0.15 })));
	synth.noteOn(60, 100);
	const start = render(synth, 0.05);
	const later = render(synth, 0.5);
	assert(energy(start) < energy(later.subarray(0, 2205)), 'a slow attack');
	synth.noteOff(60);
	render(synth, 1.5);
	assert.equal(synth.activeVoices, 0, 'the voice is released and freed');
});

test('four voices at most: the oldest note gives way, and reset silences everything', () => {
	const synth = new MicroKorgSynth({ sampleRate: RATE });
	for (const note of [60, 64, 67, 71, 74, 77]) synth.noteOn(note, 100);
	assert.equal(synth.activeVoices, 4);
	synth.noteOn(77, 100);
	assert.equal(synth.activeVoices, 4, 'a repeated note retriggers its voice');
	synth.reset();
	assert.equal(synth.activeVoices, 0);
	assert(render(synth, 0.1).every((value) => value === 0));
	synth.selectPreset(99);
	assert.equal(synth.preset, 0, 'an unknown program is ignored');
	synth.write(128, 4);
	assert.equal(synth.preset, 4, 'program change through the register port');
});

test('the catalogue lists the microKORG with its fifteen programs and it sounds', () => {
	const definition = instrumentCatalogue.find((entry) => entry.info.id === 'microkorg')!;
	assert.equal(definition.info.polyphony, 4);
	const instrument = definition.create({ sampleRate: 22050 });
	assert.equal(instrument.presets.length, 15);
	for (let index = 0; index < instrument.presets.length; index++) {
		instrument.reset();
		instrument.applyPreset(index);
		instrument.noteOn(57, 100);
		const left = new Float32Array(11025);
		instrument.render(left, new Float32Array(11025), 0, 11025);
		assert(
			left.some((value) => Math.abs(value) > 1e-3),
			`program ${index}`,
		);
		assert(left.every(Number.isFinite));
		instrument.noteOff(57);
	}
});

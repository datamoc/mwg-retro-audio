import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
	Music,
	StreamChannel,
	onMidiSynthFallback,
	parseMidi,
	registerMidiSynth,
	renderMidiThroughSynth,
	resolveMidiSynth,
	softenCutoff,
	unregisterMidiSynth,
	type AudioSettingsData,
	type MidiSynthFallback,
} from '@datamoc/mwg/audio';
import { FakeAudioContext } from '@datamoc/mwg/testing';
import {
	renderTrack,
	retroBlockSource,
	retroBusLoader,
	retroLoadFor,
	retroLoopRegion,
	retroOutputFor,
	retroPlayableFactory,
	retroSfxBackend,
	retroSfxEngineOptionsFor,
	RetroD50Synth,
	RetroDx7Synth,
	RetroPlayable,
	registerRetroMidiEngines,
	toMwgSfxDefinition,
	unregisterRetroMidiEngines,
} from '../src/mwg/index.ts';
import { loadFile, convertToMwa } from '../src/formats/load.ts';
import { buildDx7Bank } from '../src/formats/dx7.ts';
import { SfxEngine } from '../src/sfx/engine.ts';
import { Ym2149 } from '../src/chips/Ym2149.ts';
import { Region } from '../src/region.ts';
import type { SfxDefinition } from '../src/sfx/types.ts';
import { buildYm } from './ymfile.ts';

// the same minimal fake Web Audio as in webaudio.test.ts, kept short
class Node {
	connect(n: Node): Node {
		return n;
	}
	disconnect(): void {}
}
class Gain extends Node {
	gain = {
		value: 1,
		setValueAtTime(v: number): void {
			this.value = v;
		},
	};
}
class Source extends Node {
	buffer: { length: number } | null = null;
	startedAt = -1;
	stopped = false;
	onended: (() => void) | null = null;
	start(t: number): void {
		this.startedAt = t;
	}
	stop(): void {
		this.stopped = true;
	}
}
class Ctx {
	currentTime = 0;
	state = 'running';
	sampleRate = 44100;
	destination = new Node();
	sources: Source[] = [];
	createGain(): Gain {
		return new Gain();
	}
	createBufferSource(): Source {
		const s = new Source();
		this.sources.push(s);
		return s;
	}
	createBuffer(
		channels: number,
		length: number,
		sampleRate: number,
	): {
		channels: number;
		length: number;
		sampleRate: number;
		data: Float32Array[];
		copyToChannel(a: Float32Array, c: number): void;
	} {
		const data = Array.from({ length: channels }, () => new Float32Array(length));
		return { channels, length, sampleRate, data, copyToChannel: (a, c) => void data[c].set(a) };
	}
	async resume(): Promise<void> {}
}

const song = (): Uint8Array =>
	buildYm({ frames: 50, regs: () => [100, 0, 0, 0, 0, 0, 0, 0b111110, 15, 0, 0, 0, 0, 0, 0, 0], loop: 10 });

test('mwg Music crossfades a retro tune through the Playable adapter', async () => {
	mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	const ctx = new Ctx();
	const create = retroPlayableFactory({ context: ctx as unknown as AudioContext, fetchBytes: async () => song() });
	const music = new Music({ volume: 0.5, create });
	music.play('music/title.ym', 0);
	// the file is fetched and decoded asynchronously, then the stream starts
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
	assert.ok(ctx.sources.length > 0, 'the retro engine scheduled audio');
	music.update(0.016);
	mock.timers.reset();
});

test('RetroPlayable: volume is clamped, pause remembers the position, seeking restarts there, onended fires', async () => {
	mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	const ctx = new Ctx();
	const player = loadFile(song(), { sampleRate: 44100 });
	const p = new RetroPlayable(player, { context: ctx as unknown as AudioContext });
	p.volume = 3;
	assert.equal(p.volume, 1);
	let ended = 0;
	p.onended = () => ended++;
	await p.play();
	ctx.currentTime = 0.3;
	p.pause();
	assert.ok(Math.abs(p.currentTime - 0.25) < 0.01, `paused at ${p.currentTime}`);
	p.currentTime = 0.4;
	assert.equal(p.currentTime, 0.4);
	await p.play();
	ctx.currentTime = 5;
	mock.timers.tick(1000);
	mock.timers.tick(1000);
	assert.equal(ended, 1);
	p.loop = true;
	assert.equal(p.loop, true);
	mock.timers.reset();
});

test('renderTrack gives an AudioBuffer with the loop region of the file; the bus loader returns null for unknown files', async () => {
	const ctx = new Ctx();
	const player = loadFile(song(), { sampleRate: 44100 });
	const track = renderTrack(player, ctx as never);
	assert.ok(track.loop && Math.abs(track.loop.start - 10 / 50) < 1e-6 && Math.abs(track.loop.end - 1) < 0.01);
	const loader = retroBusLoader({
		context: ctx as never,
		fetchBytes: async (path) => {
			if (path === 'bgm/town.mwa') return convertToMwa(song());
			if (path === 'bgm/bad.ym') return new Uint8Array(50);
			throw new Error('missing');
		},
		locate: (kind, name) => `${kind}/${name}`,
	});
	const ok = await loader('bgm', 'town.mwa');
	assert.ok(ok && ok.loop && ok.loop.end > 0.9);
	assert.equal(await loader('bgm', 'bad.ym'), null);
	assert.equal(await loader('se', 'absent.ym'), null);
});

test('retroBlockSource streams through a mwg StreamChannel and seeks where a sequential read lands', () => {
	const context = new FakeAudioContext(8000);
	const player = loadFile(song(), { sampleRate: 8000 });
	const source = retroBlockSource(player);
	assert.equal(source.sampleRate, 8000);
	assert.ok(source.length !== undefined && Math.abs(source.length - 8000) < 400, `length ${source.length}`);
	const region = retroLoopRegion(player);
	assert.ok(region && Math.abs(region.start - 0.2) < 1e-6 && region.end > region.start);
	const channel = new StreamChannel(context.asContext(), undefined, { pumpMs: 0, chunkSeconds: 0.25 });
	channel.play(source, { repeat: false });
	channel.update();
	context.advance(0.3);
	channel.update();
	assert.ok(context.sources.length >= 1, 'the channel queued chunks of the tune');
	const heard = context.sources.some(
		(s) => s.buffer && Array.from(s.buffer.getChannelData(0)).some((v) => Math.abs(v) > 1e-4),
	);
	assert.ok(heard, 'the chunks carry the tune');
	// seeking to a frame gives the same audio a sequential read walks into
	const sought = retroBlockSource(loadFile(song(), { sampleRate: 8000 }));
	const fromSeek = new Float32Array(800);
	sought.seek(4000);
	assert.equal(sought.read(fromSeek, new Float32Array(800), 0, 800), 800);
	const walked = retroBlockSource(loadFile(song(), { sampleRate: 8000 }));
	const sequential = new Float32Array(4800);
	assert.equal(walked.read(sequential, new Float32Array(4800), 0, 4800), 4800);
	let maxDiff = 0;
	for (let i = 0; i < 800; i++) maxDiff = Math.max(maxDiff, Math.abs(fromSeek[i] - sequential[4000 + i]));
	assert.ok(maxDiff < 1e-4, `seek differs from walking there by ${maxDiff}`);
	// the stream ends: a short read, then silence, and seek(0) restarts the tune
	const tail = new Float32Array(8000);
	const rest = walked.read(tail, new Float32Array(8000), 0, 8000);
	assert.ok(rest < 8000 && rest > 0, `the source stopped short at ${rest}`);
	assert.equal(walked.read(tail, new Float32Array(8000), 0, 8000), 0, 'nothing past the end');
	walked.seek(0);
	assert.ok(
		(() => {
			const again = new Float32Array(800);
			walked.read(again, new Float32Array(800), 0, 800);
			return again.some((v) => Math.abs(v) > 1e-4);
		})(),
		'seek(0) plays the tune again',
	);
});

test('retro:mt32 joins the mwg MIDI engine registry and voices files; unknown engines report the fallback', () => {
	const names = registerRetroMidiEngines(registerMidiSynth);
	assert.deepEqual([...names].sort(), ['retro:d50', 'retro:dx7', 'retro:mt32']);
	let fell: MidiSynthFallback | null = null;
	const hear = (event: MidiSynthFallback): void => {
		fell = event;
	};
	onMidiSynthFallback.add(hear);
	const resolved = resolveMidiSynth('retro:mt32', 8000, 'builtin');
	assert.equal(resolved.name, 'retro:mt32');
	const synth = resolved.synth;
	assert.ok(synth, 'the LA model takes the request');
	synth.reset();
	synth.event(0x91, 60, 100);
	const left = new Float32Array(4000);
	const right = new Float32Array(4000);
	synth.render(left, right, 0, 4000);
	assert.ok(
		left.some((v) => Math.abs(v) > 1e-5),
		'the LA model sounds like a synth through mwg',
	);
	const missing = resolveMidiSynth(['retro:nope'], 8000, 'gm-soundfont');
	assert.equal(missing.synth, null, 'unknown names leave the internal path');
	const fallback = fell as MidiSynthFallback | null;
	assert.ok(
		fallback && fallback.requested === 'retro:nope' && fallback.reason === 'unknown',
		`fallback: ${JSON.stringify(fell)}`,
	);
	onMidiSynthFallback.remove(hear);
	assert.equal(unregisterRetroMidiEngines(unregisterMidiSynth).length, 3);
});

test('the DX7 engine renders a MIDI file through mwg and keeps a SysEx bank across resets', () => {
	const track = [0x00, 0xc0, 0x00, 0x00, 0x90, 0x3c, 0x64, 0x60, 0x80, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00];
	const smf = Uint8Array.from([
		0x4d,
		0x54,
		0x68,
		0x64,
		0,
		0,
		0,
		6,
		0,
		1,
		0,
		1,
		0,
		0x60,
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
	const synth = new RetroDx7Synth(8000);
	const rendered = renderMidiThroughSynth(parseMidi(smf), synth, { tail: 0.2 });
	assert.equal(rendered.sampleRate, 8000);
	assert.ok(rendered.duration > 0.4 && rendered.duration <= 5);
	assert.ok(
		rendered.left.some((v) => Math.abs(v) > 1e-4),
		'the DX7 voiced the file',
	);
	const bank = buildDx7Bank(
		Array.from({ length: 32 }, () => Uint8Array.from({ length: 128 }, (_, byte) => (byte % 17) + 1)),
		0,
	);
	synth.sysex(bank);
	synth.event(0xc0, 3, 0);
	synth.event(0x90, 62, 100);
	synth.event(0xe0, 0x40, 0x40);
	synth.event(0xb0, 64, 127);
	const left = new Float32Array(4000);
	const right = new Float32Array(4000);
	synth.render(left, right, 0, 4000);
	assert.ok([...left, ...right].every(Number.isFinite) && left.some((v) => v !== 0));
	synth.reset();
	const after = new Float32Array(1600);
	synth.render(after, new Float32Array(1600), 0, 1600);
	assert.ok(
		after.every((v) => v === 0),
		'reset silences the voices',
	);
	synth.event(0xb0, 64, 0);
	synth.event(0x90, 62, 100);
	const carried = new Float32Array(1600);
	synth.render(carried, new Float32Array(1600), 0, 1600);
	assert.ok(
		carried.some((v) => v !== 0),
		'the loaded bank survives the reset',
	);
});

test('the D-50 engine plays notes, ignores foreign dumps and answers all-notes-off', () => {
	const synth = new RetroD50Synth(8000);
	synth.event(0x90, 60, 100);
	const left = new Float32Array(4000);
	const right = new Float32Array(4000);
	synth.render(left, right, 0, 4000);
	assert.ok(
		left.some((v) => Math.abs(v) > 1e-5),
		'the LA model plays a MIDI note',
	);
	synth.sysex(Uint8Array.from([0xf0, 0x41, 0x10, 0x00, 0xf7])); // foreign dump: ignored, like the hardware
	synth.event(0xc0, 7, 0);
	synth.event(0xb0, 123, 0);
	synth.reset();
	const silence = new Float32Array(1600);
	synth.render(silence, new Float32Array(1600), 0, 1600);
	assert.ok(silence.every((v) => v === 0));
});

test('AudioSettings map onto the retro load and output options, mwg formulas included', () => {
	const settings: AudioSettingsData = {
		busVolumes: { bgm: 90, bgs: 90, me: 90, se: 90 },
		preferredEngine: 'retro:mt32',
		region: 'pal',
		outputStage: 'clean',
		captions: false,
		dynamics: 0.3,
		soften: 0.5,
	};
	assert.deepEqual(retroLoadFor(settings), { standard: 'pal' });
	const clean = retroOutputFor(settings, 44100);
	assert.equal(clean.dcBlock, true);
	assert.ok(clean.lowpass !== undefined && Math.abs(clean.lowpass - softenCutoff(settings.soften, 44100)) < 1e-6);
	assert.ok(clean.lowpass! <= 44100 / 2);
	assert.deepEqual(retroOutputFor({ ...settings, outputStage: 'faithful' }, 44100), {});
	assert.equal(retroSfxEngineOptionsFor(settings).region, Region.PAL);
});

test('the retro SfxBackend voices mwg bank entries on the music chips and answers with SfxVoices', () => {
	const laser: SfxDefinition = {
		name: 'laser',
		chip: 'ym2149',
		priority: 5,
		retrigger: 'restart',
		length: 30,
		voices: [
			{ channel: 'any', pitch: { start: 96, step: -1.5, min: 40 }, volume: { start: 15, step: -0.4, min: 0 } },
		],
	};
	const engine = new SfxEngine({ sampleRate: 8000 });
	engine.attach(new Ym2149({ sampleRate: 8000 }));
	engine.define(laser);
	const backend = retroSfxBackend({ engine });
	const entry = toMwgSfxDefinition(laser);
	assert.equal(entry.id, 'laser', 'the id mwg keys on is our name');
	const voice = backend.play(entry, { gain: 0.8, pan: 0, pitch: 1, seed: 7 });
	assert.ok(voice && voice.active, 'the effect sounds on the chip it shares with the music');
	assert.equal(backend.play(entry, { gain: 0, pan: 0, pitch: 1, seed: 7 }), null, 'a dropped cue is not an error');
	assert.equal(backend.play({ ...entry, name: 'nope' }, { gain: 0.8, pan: 0, pitch: 1, seed: 7 }), null);
	const pitched = backend.play(entry, { gain: 0.8, pan: 0.4, pitch: 2, seed: 7 });
	assert.ok(pitched && pitched.active, 'restart took the channel');
	assert.ok(voice !== null && !voice.active, 'the older voice was the one cut');
	pitched?.stop();
	assert.equal(pitched.active, false);
});

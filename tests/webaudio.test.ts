import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AudioDriver } from '../src/driver/AudioDriver.ts';
import { PSGVoice } from '../src/players/PSGVoice.ts';
import { Region, TrackerPlayer } from '../src/players/TrackerPlayer.ts';
import { RetroStream } from '../src/driver/RetroStream.ts';
import { createToneStream } from '../src/driver/tone.ts';
import { toAudioBuffer } from '../src/driver/Renderer.ts';
import { loadYm } from '../src/formats/ym.ts';
import { buildYm } from './ymfile.ts';

// a minimal fake of the Web Audio API: it records what the engine asks of the browser
class FakeParam {
	value = 0;
	calls: [string, number, number?][] = [];
	setValueAtTime(v: number, t: number): this {
		this.value = v;
		this.calls.push(['set', v, t]);
		return this;
	}
}
class FakeNode {
	connections: FakeNode[] = [];
	disconnected = false;
	connect(n: FakeNode): FakeNode {
		this.connections.push(n);
		return n;
	}
	disconnect(): void {
		this.disconnected = true;
	}
}
class FakeGain extends FakeNode {
	gain = new FakeParam();
}
class FakeFilter extends FakeNode {
	type = '';
	frequency = new FakeParam();
}
class FakeOsc extends FakeNode {
	type = '';
	frequency = new FakeParam();
	started = false;
	stopped = false;
	start(): void {
		this.started = true;
	}
	stop(): void {
		this.stopped = true;
	}
}
class FakeBuffer {
	data: Float32Array[];
	constructor(
		readonly numberOfChannels: number,
		readonly length: number,
		readonly sampleRate: number,
	) {
		this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
	}
	copyToChannel(src: Float32Array, ch: number): void {
		this.data[ch].set(src);
	}
}
class FakeSource extends FakeNode {
	buffer: FakeBuffer | null = null;
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
class FakeContext {
	static last: FakeContext | null = null;
	currentTime = 0;
	state = 'suspended';
	sampleRate = 44100;
	destination = new FakeNode();
	nodes: unknown[] = [];
	sources: FakeSource[] = [];
	closed = false;
	constructor() {
		FakeContext.last = this;
	}
	private reg<T>(n: T): T {
		this.nodes.push(n);
		return n;
	}
	createGain(): FakeGain {
		return this.reg(new FakeGain());
	}
	createBiquadFilter(): FakeFilter {
		return this.reg(new FakeFilter());
	}
	createOscillator(): FakeOsc {
		return this.reg(new FakeOsc());
	}
	createBuffer(c: number, l: number, r: number): FakeBuffer {
		return new FakeBuffer(c, l, r);
	}
	createBufferSource(): FakeSource {
		const s = new FakeSource();
		this.sources.push(s);
		return s;
	}
	async resume(): Promise<void> {
		this.state = 'running';
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

const g = globalThis as unknown as { AudioContext?: unknown };

test('AudioDriver builds master gain 0.2 and a 12 kHz low-pass, resumes the context, and disposes', async () => {
	g.AudioContext = FakeContext;
	const driver = new AudioDriver();
	assert.throws(() => driver.getContext(), /not initialised/);
	await driver.init();
	const ctx = driver.getContext() as unknown as FakeContext;
	assert.equal(ctx.state, 'running');
	const gain = driver.getDestination() as unknown as FakeGain;
	assert.equal(gain.gain.value, 0.2);
	const filter = gain.connections[0] as FakeFilter;
	assert.equal(filter.type, 'lowpass');
	assert.equal(filter.frequency.value, 12000);
	assert.equal(filter.connections[0], ctx.destination);
	driver.setMasterVolume(5);
	assert.equal(gain.gain.value, 1, 'clamped to 1');
	driver.setOutputCutoff(8000);
	assert.equal(filter.frequency.value, 8000);
	await driver.init(); // idempotent
	assert.equal(driver.getContext(), ctx);
	await driver.dispose();
	assert.ok(ctx.closed);
	assert.throws(() => driver.getContext());
	delete g.AudioContext;
	await assert.rejects(new AudioDriver().init(), /not available/);
});

test('PSGVoice: a square oscillator behind a gain, frequency and volume clamped, stop and dispose', () => {
	const ctx = new FakeContext();
	const dest = new FakeGain();
	const voice = new PSGVoice(ctx as unknown as AudioContext, dest as unknown as GainNode);
	const osc = ctx.nodes[0] as FakeOsc;
	const gain = ctx.nodes[1] as FakeGain;
	assert.equal(osc.type, 'square');
	assert.ok(osc.started);
	assert.equal(gain.gain.value, 0);
	assert.equal(gain.connections[0], dest);
	voice.setFrequency(440);
	voice.setVolume(2);
	assert.equal(osc.frequency.value, 440);
	assert.equal(gain.gain.value, 1);
	voice.setVolume(-1);
	assert.equal(gain.gain.value, 0);
	voice.setVolume(0.5);
	voice.stop();
	assert.equal(gain.gain.value, 0);
	voice.dispose();
	assert.ok(osc.stopped && osc.disconnected && gain.disconnected);
});

test('TrackerPlayer: one step per frame at 50 Hz (PAL) or 60 Hz (NTSC), arpeggio cycles per tick, rests silence', () => {
	for (const [region, hz] of [
		[Region.PAL, 50],
		[Region.NTSC, 60],
	] as const) {
		mock.timers.enable({ apis: ['setInterval'] });
		const ctx = new FakeContext();
		const voice = new PSGVoice(ctx as unknown as AudioContext, new FakeGain() as unknown as GainNode);
		const osc = ctx.nodes[0] as FakeOsc;
		const gain = ctx.nodes[1] as FakeGain;
		const player = new TrackerPlayer(voice, Region.PAL);
		player.loadSteps(
			[
				{ note: 69, volume: 15, arpeggio: [0, 12] },
				{ note: 69, volume: 15, arpeggio: [0, 12] },
				{ note: null, volume: 0 },
			],
			region,
		);
		player.start();
		player.start(); // no second timer
		const interval = 1000 / hz;
		mock.timers.tick(interval);
		assert.equal(osc.frequency.value, 440);
		assert.equal(gain.gain.value, 1);
		mock.timers.tick(interval);
		assert.equal(osc.frequency.value, 880, 'arpeggio advanced one entry');
		mock.timers.tick(interval);
		assert.equal(gain.gain.value, 0, 'rest');
		mock.timers.tick(interval);
		assert.equal(osc.frequency.value, 440, 'the sequence loops');
		assert.equal(interval, region === Region.PAL ? 20 : 1000 / 60);
		player.stop();
		const before = osc.frequency.calls.length;
		mock.timers.tick(interval * 5);
		assert.equal(osc.frequency.calls.length, before, 'stopped');
		assert.equal(gain.gain.value, 0);
		mock.timers.reset();
	}
});

test('RetroStream schedules gapless buffers ahead of the clock and finishes when the music ends', () => {
	mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	const ctx = new FakeContext();
	ctx.state = 'running';
	const player = loadYm(
		buildYm({ frames: 25, regs: () => [100, 0, 0, 0, 0, 0, 0, 0b111110, 15, 0, 0, 0, 0, 0, 0, 0] }),
		{ sampleRate: 44100 },
	);
	const stream = new RetroStream(ctx as unknown as AudioContext, new FakeNode() as unknown as AudioNode, player, {
		chunkSeconds: 0.2,
		lookaheadSeconds: 0.6,
	});
	let ended = 0;
	stream.onended = () => ended++;
	stream.start();
	assert.ok(stream.isPlaying);
	const first = ctx.sources.length;
	assert.ok(first >= 3 && first <= 4, `${first} chunks scheduled up front`);
	// consecutive chunks follow each other without gap or overlap
	for (let i = 1; i < ctx.sources.length; i++) {
		const prev = ctx.sources[i - 1];
		assert.ok(Math.abs(ctx.sources[i].startedAt - (prev.startedAt + prev.buffer!.length / 44100)) < 1e-9);
	}
	ctx.currentTime = 0.5;
	mock.timers.tick(100);
	assert.ok(ctx.sources.length >= first);
	ctx.currentTime = 2;
	mock.timers.tick(400);
	mock.timers.tick(400);
	assert.equal(ended, 1, 'ended once');
	assert.ok(!stream.isPlaying);
	assert.throws(
		() =>
			new RetroStream(
				{ ...ctx, sampleRate: 48000 } as unknown as AudioContext,
				new FakeNode() as unknown as AudioNode,
				player,
			),
		/differs/,
	);
	mock.timers.reset();
});

test('toAudioBuffer copies rendered audio into an AudioBuffer', () => {
	const ctx = new FakeContext();
	const buf = toAudioBuffer(ctx as never, {
		sampleRate: 44100,
		left: Float32Array.of(0.5, -0.5),
		right: Float32Array.of(0.25, 0.1),
		duration: 2 / 44100,
		ended: true,
	}) as unknown as FakeBuffer;
	assert.equal(buf.numberOfChannels, 2);
	assert.deepEqual([...buf.data[0]], [0.5, -0.5]);
	assert.deepEqual([...buf.data[1]], [0.25, Math.fround(0.1)]);
});

test('Tone bridge shares the native context, routes only through its input and disposes sources', () => {
	mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	try {
		const ctx = new FakeContext();
		const effect = new FakeNode();
		const connections: unknown[][] = [];
		const player = loadYm(
			buildYm({ frames: 25, regs: () => [100, 0, 0, 0, 0, 0, 0, 62, 15, 0, 0, 0, 0, 0, 0, 0] }),
		);
		const bridge = createToneStream(
			{
				getContext: () => ({ rawContext: ctx as unknown as AudioContext }),
				connect: (source, destination) => {
					connections.push([source, destination]);
				},
			},
			effect,
			player,
		);
		bridge.stream.start(0.3);
		assert.equal(ctx.sources[0].startedAt, 0.3);
		assert.deepEqual(connections, [[bridge.input, effect]]);
		assert(ctx.sources.every((source) => source.connections[0] === (bridge.input as unknown)));
		bridge.dispose();
		assert(ctx.sources.every((source) => source.stopped && source.disconnected));
		assert.equal(bridge.stream.isPlaying, false);
	} finally {
		mock.timers.reset();
	}
});

test('stopping a finite stream cancels its old end callback before restarting', () => {
	mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	try {
		const ctx = new FakeContext();
		const player = loadYm(buildYm({ frames: 1, regs: () => new Array(16).fill(0) }));
		const stream = new RetroStream(ctx as unknown as AudioContext, new FakeNode() as unknown as AudioNode, player);
		stream.start();
		stream.stop();
		player.reset();
		stream.start(5);
		mock.timers.tick(300);
		assert.equal(stream.isPlaying, true);
		stream.stop();
		assert.throws(() => stream.start(-1), RangeError);
	} finally {
		mock.timers.reset();
	}
});

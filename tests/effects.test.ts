import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetroEffectChain } from '../src/effects/chain.ts';
import { processRetroEffects } from '../src/effects/pcm.ts';
import {
	RETRO_EFFECT_PRESETS,
	retroEffectNames,
	retroEffects,
	type RetroEffectPreset,
} from '../src/effects/presets.ts';
import { renderSfx } from '../src/sfx/engine.ts';
import type { SfxDefinition } from '../src/sfx/types.ts';

class FakeParam {
	value = 0;
	calls: { value: number; time: number }[] = [];
	setValueAtTime(value: number, time: number): this {
		this.value = value;
		this.calls.push({ value, time });
		return this;
	}
}

class FakeNode {
	connections: FakeNode[] = [];
	disconnected = false;
	connect(node: FakeNode): FakeNode {
		this.connections.push(node);
		return node;
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
	Q = new FakeParam();
}

class FakeShaper extends FakeNode {
	curve: Float32Array | null = null;
	oversample = 'none';
}

class FakeProcessor extends FakeNode {
	onaudioprocess: ((event: { inputBuffer: FakeBuffer; outputBuffer: FakeBuffer }) => void) | null = null;
	channelCount = 2;
	channelCountMode = 'max';
	constructor(readonly bufferSize: number) {
		super();
	}
}

class FakeBuffer {
	constructor(
		private readonly channels: Float32Array[],
		readonly sampleRate = 44100,
	) {}
	get numberOfChannels(): number {
		return this.channels.length;
	}
	get length(): number {
		return this.channels[0].length;
	}
	getChannelData(channel: number): Float32Array {
		return this.channels[channel];
	}
}

class FakeEffectContext {
	sampleRate = 44100;
	currentTime = 0;
	destination = new FakeNode();
	nodes: FakeNode[] = [];
	createGain(): FakeGain {
		return this.reg(new FakeGain());
	}
	createBiquadFilter(): FakeFilter {
		return this.reg(new FakeFilter());
	}
	createWaveShaper(): FakeShaper {
		return this.reg(new FakeShaper());
	}
	createScriptProcessor(bufferSize: number): FakeProcessor {
		return this.reg(new FakeProcessor(bufferSize));
	}
	private reg<T extends FakeNode>(node: T): T {
		this.nodes.push(node);
		return node;
	}
}

class NoProcessorContext extends FakeEffectContext {
	// @ts-expect-error -- a context without the deprecated node is the point of this double
	createScriptProcessor = undefined;
}

test('built-in presets are stable data and every name resolves', () => {
	assert.deepEqual(
		retroEffects('nes'),
		{
			name: 'nes',
			label: 'NES / Famicom',
			description: '8-bit converter, 22 kHz sample-and-hold and the console output low-pass.',
			sampleRateReduction: { rate: 22050 },
			bitcrush: { bits: 8 },
			lowpass: { frequency: 14000, q: Math.SQRT1_2, order: 2 },
		},
		'a preset change would change what the named effect sounds like',
	);
	assert.deepEqual(retroEffects('sid').lowpass, { frequency: 8000, q: 1, order: 2 });
	assert.deepEqual(retroEffects('mega-drive').dac, { bits: 9, crossover: 0.01 });
	assert.deepEqual(retroEffects('pc-speaker').highpass, { frequency: 300, q: Math.SQRT1_2 });
	assert.ok(Object.isFrozen(retroEffects('sid').lowpass), 'nested preset parameters cannot be mutated');
	for (const name of retroEffectNames()) {
		const preset = retroEffects(name);
		assert.equal(preset.name, name);
		assert.ok(preset.label.length > 0 && preset.description.length > 0);
	}
	assert.deepEqual(retroEffectNames(), Object.keys(RETRO_EFFECT_PRESETS));
	assert.throws(() => retroEffects('nope' as never), /unknown retro effect 'nope'/);
});

test('custom presets are validated before a chain is built', () => {
	const custom: RetroEffectPreset = { name: 'custom', label: 'Custom', description: 'A test preset.' };
	assert.deepEqual(retroEffects(custom), custom);
	assert.throws(() => retroEffects({ ...custom, label: ' ' }), /needs a label/);
	assert.throws(() => retroEffects({ ...custom, bitcrush: { bits: 0 } }), /bitcrush.bits/);
	assert.throws(() => retroEffects({ ...custom, sampleRateReduction: { rate: 0 } }), /rate/);
	assert.throws(() => retroEffects({ ...custom, dac: { crossover: 2 } }), /crossover/);
	assert.throws(() => retroEffects({ ...custom, gain: -1 }), /gain/);
});

test('the offline pass applies sample-and-hold, quantisation and gain deterministically', () => {
	const ramp = Float32Array.from({ length: 8 }, (_, i) => -1 + (2 * i) / 7);
	const right = Float32Array.from(ramp);
	const result = processRetroEffects(ramp, right, 44100, {
		name: 'test',
		label: 'Test',
		description: 'half rate, two bits',
		sampleRateReduction: { rate: 22050 },
		bitcrush: { bits: 2 },
	});
	assert.deepEqual(result.stages, ['sample-rate-reduction', 'bitcrush']);
	assert.deepEqual(result.omitted, []);
	for (let i = 0; i < ramp.length; i++) {
		if (i % 2 === 1) assert.equal(ramp[i], ramp[i - 1], 'held at the reduced rate');
		assert.ok(Math.abs(ramp[i] * 2 - Math.round(ramp[i] * 2)) < 1e-6, 'two-bit grid');
	}
});

test('a dry preset leaves the buffer untouched', () => {
	const left = Float32Array.of(-0.7, 0.1, 0.9);
	const right = Float32Array.of(0.3, -0.2, 0.4);
	const beforeLeft = Float32Array.from(left);
	const beforeRight = Float32Array.from(right);
	const result = processRetroEffects(left, right, 44100, 'none');
	assert.deepEqual(result.stages, []);
	assert.deepEqual(left, beforeLeft);
	assert.deepEqual(right, beforeRight);
});

test('a gain-only preset scales the buffer and reports the stage', () => {
	const left = Float32Array.of(-0.5, 0.25);
	const right = Float32Array.of(0.5, -0.25);
	const result = processRetroEffects(left, right, 44100, {
		name: 'quiet',
		label: 'Quiet',
		description: 'Half level.',
		gain: 0.5,
	});
	assert.deepEqual(result.stages, ['gain']);
	assert.deepEqual([...left], [-0.25, 0.125]);
	assert.deepEqual([...right], [0.25, -0.125]);
});

test('the live chain wires every stage in signal order and retunes in place', () => {
	const ctx = new FakeEffectContext();
	const chain = createRetroEffectChain(ctx as unknown as BaseAudioContext, 'atari-st');
	assert.deepEqual(chain.stages, ['highpass', 'lowpass']);
	assert.deepEqual(chain.omitted, []);
	const [input, output, highpass, lowpass1, lowpass2, shaper, processor] = ctx.nodes as [
		FakeGain,
		FakeGain,
		FakeFilter,
		FakeFilter,
		FakeFilter,
		FakeShaper,
		FakeProcessor,
	];
	assert.deepEqual(
		chain.nodes,
		[input, highpass, processor, shaper, lowpass1, lowpass2, output],
		'nodes expose the insertion order to a host',
	);
	assert.equal(chain.input, input);
	assert.equal(chain.output, output);
	assert.equal(input.connections[0], highpass);
	assert.equal(highpass.connections[0], processor);
	assert.equal(processor.connections[0], shaper);
	assert.equal(shaper.connections[0], lowpass1);
	assert.equal(lowpass1.connections[0], lowpass2);
	assert.equal(lowpass2.connections[0], output);
	assert.equal(highpass.type, 'highpass');
	assert.equal(highpass.frequency.value, 14);
	assert.equal(lowpass1.frequency.value, 15000);
	assert.equal(lowpass2.frequency.value, 20000, 'one-pole preset bypasses the second section');
	assert.equal(chain.preset.name, 'atari-st');

	chain.setPreset('nes');
	assert.equal(chain.preset.name, 'nes');
	assert.equal(highpass.frequency.value, 1, 'a preset without a high-pass leaves the section nearly neutral');
	assert.ok(shaper.curve, 'bitcrush curve installed');
	assert.equal(processor.channelCount, 2);
	// 22.05 kHz at 44.1 kHz holds every other frame
	const inLeft = Float32Array.of(0, 1, 2, 3, 4, 5, 6, 7);
	const inRight = Float32Array.of(10, 11, 12, 13, 14, 15, 16, 17);
	const outLeft = new Float32Array(8);
	const outRight = new Float32Array(8);
	processor.onaudioprocess!({
		inputBuffer: new FakeBuffer([inLeft, inRight]),
		outputBuffer: new FakeBuffer([outLeft, outRight]),
	});
	assert.deepEqual([...outLeft], [0, 0, 2, 2, 4, 4, 6, 6]);
	assert.deepEqual([...outRight], [10, 10, 12, 12, 14, 14, 16, 16]);

	chain.dispose();
	assert.ok(ctx.nodes.every((node) => (node === processor ? processor.onaudioprocess === null : node.disconnected)));
	assert.throws(() => chain.setPreset('sid'), /disposed/);
});

test('connect:false leaves the wiring to a host that inserts the nodes itself', () => {
	const ctx = new FakeEffectContext();
	const chain = createRetroEffectChain(ctx as unknown as BaseAudioContext, 'sid', { connect: false });
	assert.deepEqual(chain.stages, ['sample-rate-reduction', 'bitcrush', 'lowpass']);
	assert.equal(chain.nodes.length, 7);
	assert.ok(
		ctx.nodes.every((node) => node.connections.length === 0),
		'no internal edges',
	);
	chain.dispose();
	assert.ok(ctx.nodes.every((node) => node.disconnected));
});

test('a context without a script processor omits sample-and-hold instead of failing', () => {
	const ctx = new NoProcessorContext();
	const chain = createRetroEffectChain(ctx as unknown as BaseAudioContext, 'gameboy');
	assert.deepEqual(chain.stages, ['bitcrush', 'lowpass']);
	assert.deepEqual(chain.omitted, ['sample-rate-reduction']);
	const input = ctx.nodes[0] as FakeGain;
	const highpass = ctx.nodes[2] as FakeFilter;
	const shaper = ctx.nodes[5] as FakeShaper;
	assert.equal(input.connections[0], highpass);
	assert.equal(highpass.connections[0], shaper);
	assert.ok(shaper.curve);
	chain.dispose();
});

test('renderSfx applies a retro preset to an ordinary sound effect render', () => {
	const definition: SfxDefinition = {
		name: 'laser',
		chip: 'ym2149',
		priority: 5,
		retrigger: 'restart',
		length: 30,
		voices: [{ channel: 0, pitch: { start: 96, step: -1.5, min: 40 }, volume: { start: 15, step: -0.4, min: 0 } }],
	};
	const dry = renderSfx(definition, 0.3, { sampleRate: 22050 });
	const crushed = renderSfx(definition, 0.3, { sampleRate: 22050, effects: 'gameboy' });
	assert.equal(crushed.sampleRate, 22050);
	assert.ok(crushed.left.every(Number.isFinite) && crushed.right.every(Number.isFinite));
	assert.notDeepEqual(crushed.left, dry.left, 'the preset changes the rendered bytes');
	assert.notDeepEqual(crushed.right, dry.right);
	assert.ok(dry.left.some((value) => Math.abs(value) > 0.001));
	assert.ok(crushed.left.some((value) => Math.abs(value) > 0.001));
});

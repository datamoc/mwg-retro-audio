import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Channel } from '@datamoc/mwg/audio';
import { FakeAudioContext } from '@datamoc/mwg/testing';
import { retroEffectsFor, retroEffectsLoader, type RetroEffectsTarget } from '../src/mwg/effects.ts';
import type { RetroEffectChain } from '../src/effects/chain.ts';

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
	gain = {
		value: 1,
		setValueAtTime(value: number): void {
			this.value = value;
		},
	};
}

class FakeFilter extends FakeNode {
	type = '';
	frequency = {
		value: 0,
		setValueAtTime(value: number): void {
			this.value = value;
		},
	};
	Q = {
		value: 0,
		setValueAtTime(value: number): void {
			this.value = value;
		},
	};
}

class FakeShaper extends FakeNode {
	curve: Float32Array | null = null;
	oversample = 'none';
}

class FakeProcessor extends FakeNode {
	onaudioprocess: ((event: unknown) => void) | null = null;
	channelCount = 2;
	channelCountMode = 'max';
}

class FakeContext {
	sampleRate = 44100;
	currentTime = 0;
	destination = new FakeNode();
	createGain(): FakeGain {
		return new FakeGain();
	}
	createBiquadFilter(): FakeFilter {
		return new FakeFilter();
	}
	createWaveShaper(): FakeShaper {
		return new FakeShaper();
	}
	createScriptProcessor(): FakeProcessor {
		return new FakeProcessor();
	}
}

class ChannelLike {
	readonly context = new FakeContext();
	destination: FakeNode = new FakeNode();
}

class InsertChannel {
	readonly context = new FakeContext();
	destination: FakeNode = new FakeNode();
	inserts: FakeNode[] = [];
	insert(node: FakeNode): void {
		this.inserts.push(node);
	}
	removeInsert(node: FakeNode): void {
		const at = this.inserts.indexOf(node);
		if (at >= 0) this.inserts.splice(at, 1);
	}
}

class EffectHost {
	readonly context = new FakeContext();
	inserted: RetroEffectChain | null = null;
	removed: RetroEffectChain | null = null;
	insertEffect(chain: RetroEffectChain): void {
		this.inserted = chain;
	}
	removeEffect(chain: RetroEffectChain): void {
		this.removed = chain;
	}
}

test('retroEffectsFor reroutes a Channel-like destination and restores it on dispose', () => {
	const channel = new ChannelLike();
	const original = channel.destination;
	const handle = retroEffectsFor(channel as unknown as RetroEffectsTarget, 'sid');
	assert.equal(handle.preset.name, 'sid');
	assert.equal(channel.destination, handle.chain.input as unknown as FakeNode);
	assert.equal((handle.chain.output as unknown as FakeNode).connections[0], original);
	handle.setPreset('nes');
	assert.equal(handle.preset.name, 'nes');
	handle.dispose();
	assert.equal(channel.destination, original, 'routing is back to where it was');
	assert.ok((handle.chain.input as unknown as FakeGain).disconnected);
	assert.throws(() => handle.setPreset('sid'), /disposed/);
});

test('a host with insertEffect receives the whole chain and removeEffect detaches it', () => {
	const host = new EffectHost();
	const handle = retroEffectsFor(host as unknown as RetroEffectsTarget, 'pc-speaker');
	assert.equal(host.inserted, handle.chain);
	assert.equal(host.removed, null);
	handle.dispose();
	assert.equal(host.removed, handle.chain);
	assert.ok((handle.chain.input as unknown as FakeGain).disconnected);
});

test('insert/removeInsert receive the chain nodes in signal order', () => {
	const channel = new InsertChannel();
	const original = channel.destination;
	const handle = retroEffectsFor(channel as unknown as RetroEffectsTarget, 'sid');
	assert.deepEqual(channel.inserts, [...handle.chain.nodes]);
	assert.equal(channel.destination, original, 'the native insert path keeps the destination');
	handle.setPreset('nes');
	assert.equal(channel.inserts.length, handle.chain.nodes.length);
	handle.dispose();
	assert.deepEqual(channel.inserts, []);
	assert.ok((handle.chain.input as unknown as FakeGain).disconnected);
});

test('retroEffectsFor uses the real mwg 0.53 Channel inserts and removes them', () => {
	const context = new FakeAudioContext();
	const patched = context as unknown as {
		createBiquadFilter(): FakeFilter;
		createWaveShaper(): FakeShaper;
	};
	patched.createBiquadFilter = () => new FakeFilter();
	patched.createWaveShaper = () => new FakeShaper();
	const channel = new Channel(context.asContext());
	const original = (channel as unknown as { destination: FakeNode }).destination;
	const inserts = (channel as unknown as { inserts: unknown[] }).inserts;
	const handle = retroEffectsFor(channel, 'sid');
	assert.deepEqual(inserts, [...handle.chain.nodes]);
	assert.equal((channel as unknown as { destination: FakeNode }).destination, original);
	handle.dispose();
	assert.deepEqual(inserts, []);
	assert.equal((channel as unknown as { destination: FakeNode }).destination, original);
});

test('retroEffectsLoader processes ordinary buffered SE and leaves a missing track null', async () => {
	const context = new FakeAudioContext();
	const stereo = context.createBuffer(2, 4, 44100);
	stereo.getChannelData(0).set([0, 1, 2, 3]);
	stereo.getChannelData(1).set([10, 11, 12, 13]);
	const base = async () => ({ buffer: stereo as unknown as AudioBuffer, loop: null });
	const wrapped = retroEffectsLoader(base, {
		name: 'half-rate',
		label: 'Half rate',
		description: 'Sample-and-hold at half the rate.',
		sampleRateReduction: { rate: 22050 },
	});
	const track = await wrapped('se', 'door.wav');
	assert.ok(track);
	assert.deepEqual([...stereo.getChannelData(0)], [0, 0, 2, 2]);
	assert.deepEqual([...stereo.getChannelData(1)], [10, 10, 12, 12]);
	await wrapped('se', 'door.wav');
	assert.deepEqual([...stereo.getChannelData(0)], [0, 0, 2, 2], 'a cached buffer is processed only once');
	assert.deepEqual([...stereo.getChannelData(1)], [10, 10, 12, 12]);

	const mono = context.createBuffer(1, 4, 44100);
	mono.getChannelData(0).set([0, 1, 2, 3]);
	const monoLoader = retroEffectsLoader(async () => ({ buffer: mono as unknown as AudioBuffer, loop: null }), {
		name: 'half-rate',
		label: 'Half rate',
		description: 'Sample-and-hold at half the rate.',
		sampleRateReduction: { rate: 22050 },
	});
	await monoLoader('se', 'mono.wav');
	assert.deepEqual([...mono.getChannelData(0)], [0, 0, 2, 2]);

	const missing = retroEffectsLoader(async () => null, 'nes');
	assert.equal(await missing('se', 'missing.wav'), null);
	assert.throws(() => retroEffectsLoader(base, 'nope' as never), /unknown retro effect 'nope'/);
});

test('a custom host without inserts or a destination fails loudly, and context can be supplied', () => {
	const context = new FakeContext();
	assert.throws(
		() => retroEffectsFor({} as RetroEffectsTarget, 'nes', { context: context as unknown as BaseAudioContext }),
		/neither insert\(\), insertEffect\(\) nor a destination/,
	);
	assert.throws(() => retroEffectsFor({} as RetroEffectsTarget, 'nes'), /cannot find an AudioContext/);
	const channel = new ChannelLike();
	assert.throws(
		() => retroEffectsFor(channel as unknown as RetroEffectsTarget, 'nope' as never),
		/unknown retro effect 'nope'/,
	);
	assert.equal(channel.destination instanceof FakeNode, true, 'a bad preset does not rewire anything');
});

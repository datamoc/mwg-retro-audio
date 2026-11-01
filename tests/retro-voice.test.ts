import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RetroVoice, noteToFrequency, retroSequencer, retroVoice } from '../src/players/RetroVoice.ts';

class FakeParam {
	value = 0;
	calls: { value: number; time: number }[] = [];
	cancelled: number[] = [];
	setValueAtTime(value: number, time: number): this {
		this.value = value;
		this.calls.push({ value, time });
		return this;
	}
	cancelScheduledValues(time: number): this {
		this.cancelled.push(time);
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

class FakeOsc extends FakeNode {
	type = 'sine';
	frequency = new FakeParam();
	starts = 0;
	stops = 0;
	start(): void {
		this.starts++;
	}
	stop(): void {
		this.stops++;
	}
}

class VoiceContext {
	currentTime = 0;
	destination = new FakeNode();
	nodes: FakeNode[] = [];
	createOscillator(): FakeOsc {
		return this.reg(new FakeOsc());
	}
	createGain(): FakeGain {
		return this.reg(new FakeGain());
	}
	private reg<T extends FakeNode>(node: T): T {
		this.nodes.push(node);
		return node;
	}
}

function context(): VoiceContext {
	return new VoiceContext();
}

function asAudioContext(ctx: VoiceContext): AudioContext {
	return ctx as unknown as AudioContext;
}

function asNode(node: FakeNode): AudioNode {
	return node as unknown as AudioNode;
}

test('noteToFrequency reads MIDI numbers and scientific pitch names', () => {
	assert.equal(noteToFrequency(69), 440);
	assert.equal(noteToFrequency('A4'), 440);
	assert.equal(noteToFrequency('a4'), 440);
	assert.ok(Math.abs(noteToFrequency('C4') - 261.6255653005986) < 1e-9);
	assert.ok(Math.abs(noteToFrequency('C#4') - 277.1826309768721) < 1e-9);
	assert.ok(Math.abs(noteToFrequency('Db4') - 277.1826309768721) < 1e-9);
	assert.ok(Math.abs(noteToFrequency('A#3') - 233.08188075904496) < 1e-9);
	assert.throws(() => noteToFrequency('rest'), /invalid note/);
	assert.throws(() => noteToFrequency('H4'), /invalid note/);
	assert.throws(() => noteToFrequency(128), /out of MIDI range/);
	assert.throws(() => noteToFrequency(-1), /out of MIDI range/);
});

test('retroVoice picks the chip waveform, schedules frequency and volume, and stops', () => {
	const ctx = context();
	const voice = retroVoice({ chip: 'sid', context: asAudioContext(ctx), destination: asNode(new FakeNode()) });
	const osc = ctx.nodes[0] as FakeOsc;
	const gain = ctx.nodes[1] as FakeGain;
	assert.equal(osc.type, 'sawtooth');
	assert.equal(gain.gain.value, 0.2, 'default headroom');
	voice.setFrequency(330, 1.5);
	assert.deepEqual(osc.frequency.calls.at(-1), { value: 330, time: 1.5 });
	voice.setVolume(2, 2);
	assert.equal(gain.gain.value, 1, 'clamped');
	voice.stop(3);
	assert.deepEqual(gain.gain.calls.at(-1), { value: 0, time: 3 });
	voice.dispose();
	assert.equal(osc.stops, 1);
	assert.ok(osc.disconnected && gain.disconnected);
});

test('a waveform override wins and an unknown chip name fails loudly', () => {
	const ctx = context();
	const voice = retroVoice({
		chip: 'nes',
		waveform: 'triangle',
		context: asAudioContext(ctx),
		destination: asNode(new FakeNode()),
	});
	assert.equal((ctx.nodes[0] as FakeOsc).type, 'triangle');
	voice.dispose();
	assert.throws(
		() =>
			retroVoice({
				chip: 'nope' as never,
				context: asAudioContext(ctx),
				destination: asNode(new FakeNode()),
			}),
		/unknown retro voice chip/,
	);
});

test('playNotes schedules the note list on the audio clock and reports its span', () => {
	const ctx = context();
	const voice = retroVoice({ chip: 'ay', context: asAudioContext(ctx), destination: asNode(new FakeNode()) });
	const osc = ctx.nodes[0] as FakeOsc;
	const gain = ctx.nodes[1] as FakeGain;
	const sequence = voice.playNotes([
		{ note: 'A4', at: 0, duration: 0.5 },
		{ note: 'C5', at: 1, duration: 0.25, volume: 0.5 },
	]);
	assert.equal(sequence.startedAt, 0.02);
	assert.equal(sequence.endsAt, 1.27);
	assert.equal(sequence.notes, 2);
	assert.deepEqual(
		osc.frequency.calls.map((call) => call.time),
		[0.02, 1.02],
	);
	assert.ok(Math.abs((osc.frequency.calls[1].value ?? 0) - 523.2511306011972) < 1e-9);
	assert.deepEqual(
		gain.gain.calls.filter((call) => call.time >= 0.02).map((call) => [call.time, call.value]),
		[
			[0.02, 0.2],
			[0.52, 0],
			[1.02, 0.5],
			[1.27, 0],
			[1.27, 0],
		],
	);
	sequence.stop();
	assert.deepEqual(gain.gain.calls.at(-1), { value: 0, time: 0 });
	assert.ok(gain.gain.cancelled.includes(0), 'future note events are cancelled');
	assert.ok(osc.frequency.cancelled.includes(0), 'future pitch events are cancelled');
});

test('a looping sequence schedules one pass ahead and can be stopped', () => {
	mock.timers.enable({ apis: ['setInterval'] });
	try {
		const ctx = context();
		const voice = retroVoice({ chip: 'ay', context: asAudioContext(ctx), destination: asNode(new FakeNode()) });
		const osc = ctx.nodes[0] as FakeOsc;
		const sequence = voice.playNotes([{ note: 'A4', at: 0, duration: 0.1 }], { loop: true, volume: 0.3 });
		assert.equal(sequence.endsAt, Number.POSITIVE_INFINITY);
		assert.deepEqual(
			osc.frequency.calls.map((call) => Number(call.time.toFixed(6))),
			[0.02, 0.12],
			'first two passes are scheduled up front',
		);
		mock.timers.tick(100);
		const scheduled = osc.frequency.calls.at(-1)!;
		assert.equal(scheduled.value, 440);
		assert.equal(Number(scheduled.time.toFixed(6)), 0.22);
		sequence.stop();
		const calls = osc.frequency.calls.length;
		mock.timers.tick(1000);
		assert.equal(osc.frequency.calls.length, calls, 'stopping clears the loop timer');
	} finally {
		mock.timers.reset();
	}
});

test('retroSequencer is the convenience form of playNotes and new sequences replace old ones', () => {
	const ctx = context();
	const voice = retroVoice({ chip: 'ay', context: asAudioContext(ctx), destination: asNode(new FakeNode()) });
	const first = retroSequencer(voice, [{ note: 60, at: 0, duration: 0.2 }]);
	const second = voice.playNotes([{ note: 62, at: 0, duration: 0.2 }]);
	first.stop(); // the handle of a replaced sequence does not silence the current one
	const gain = ctx.nodes[1] as FakeGain;
	const before = gain.gain.calls.length;
	second.stop();
	assert.equal(gain.gain.calls.length, before + 1);
});

test('RetroVoice rejects malformed note lists', () => {
	const ctx = context();
	const voice = new RetroVoice({ context: asAudioContext(ctx), destination: asNode(new FakeNode()) });
	assert.throws(() => voice.playNotes([{ note: 'A4', at: -1, duration: 0.1 }]), /note start/);
	assert.throws(() => voice.playNotes([{ note: 'A4', at: 0, duration: 0 }]), /duration/);
	assert.throws(() => voice.playNotes([{ note: 'A4', at: 0, duration: 0.1, volume: 2 }]), /volume/);
	assert.throws(() => voice.playNotes([{ note: 'X4', at: 0, duration: 0.1 }]), /invalid note/);
	assert.throws(() => voice.playNotes([]), /at least one note/);
	voice.dispose();
});

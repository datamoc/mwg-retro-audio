import type { MidiSynth, MidiSynthFactory } from '@datamoc/mwg/audio';
import { D50Synth, D50_PRESETS } from '../chips/historical.ts';
import { Mt32Synth } from '../chips/Mt32Synth.ts';
import { Dx7Synth } from '../chips/Dx7.ts';
import { parseD50SysEx, type D50SysExPatch } from '../formats/d50.ts';
import { isDx7Bank, isDx7Single, parseDx7Bank, parseDx7Single, parseDx7Voice, type Dx7Voice } from '../formats/dx7.ts';

/** the MT-32 LA model already has the `MidiSynth` face: event, sysex, render, reset, sampleRate */
const mt32Engine: MidiSynthFactory = (sampleRate) => new Mt32Synth(sampleRate);

/**
 * A full-scale dump or single-voice dump, whether or not the caller kept the leading 0xF0
 * and the trailing 0xF7: the mwg contract allows both, the DX7 parsers read the real messages.
 */
function asSystemExclusive(bytes: Uint8Array): Uint8Array {
	if (bytes.length === 0 || bytes[0] === 0xf0) return bytes;
	const wrapped = new Uint8Array(bytes.length + 2);
	wrapped[0] = 0xf0;
	wrapped.set(bytes, 1);
	wrapped[wrapped.length - 1] = 0xf7;
	return wrapped;
}

/** the voice the DX7 engine starts with: every operator at unity, one carrier at full (the demo patch) */
function defaultDx7Voice(): Dx7Voice {
	const voice = parseDx7Voice(new Uint8Array(128));
	voice.algorithm = 31;
	voice.pitchEgLevels = [50, 50, 50, 50];
	voice.pitchEgRates = [99, 99, 99, 99];
	voice.transpose = 24;
	voice.operators.forEach((operator, index) => {
		operator.rates = [99, 70, 70, 60];
		operator.levels = [99, 80, 80, 0];
		operator.detune = 7;
		operator.freqCoarse = 1;
		operator.outputLevel = index === 5 ? 99 : 0;
	});
	return voice;
}

/**
 * A Yamaha DX7 voicing MIDI through mwg's `MidiSynth` contract. Notes, pitch bend, the
 * modulation wheel, the sustain pedal and all-notes-off are modelled; a bank dump (SysEx
 * `F0 43 ... 09 20 00`, or its body without the framing) loads 32 voices and program changes
 * pick from them; a single-voice dump replaces the current voice. Without a dump the engine
 * plays a plain one-carrier patch, like a DX7 with no cartridge. One part: every channel
 * voices the same 16 notes, the way the serial box of a single DX7 behaves.
 */
export class RetroDx7Synth implements MidiSynth {
	readonly sampleRate: number;
	private readonly synth: Dx7Synth;
	constructor(sampleRate = 44100) {
		this.sampleRate = sampleRate;
		this.synth = new Dx7Synth({ sampleRate });
		this.synth.loadVoice(defaultDx7Voice());
	}
	event(status: number, data1: number, data2: number): void {
		switch (status & 0xf0) {
			case 0x80:
				this.synth.noteOff(data1);
				break;
			case 0x90:
				if (data2 > 0) this.synth.noteOn(data1, data2);
				else this.synth.noteOff(data1);
				break;
			case 0xb0:
				if (data1 === 1) this.synth.setModWheel(data2 / 127);
				else if (data1 === 64) this.synth.setSustain(data2 >= 64);
				else if (data1 === 120 || data1 === 123)
					for (let note = 0; note < 128; note++) this.synth.noteOff(note);
				break;
			case 0xc0:
				this.synth.selectVoice(data1 & 127);
				break;
			case 0xe0:
				this.synth.setPitchBend((((data2 << 7) | data1) - 8192) / 8192);
				break;
		}
	}
	sysex(bytes: Uint8Array): void {
		const message = asSystemExclusive(bytes);
		if (isDx7Bank(message)) this.synth.loadBank(parseDx7Bank(message));
		else if (isDx7Single(message)) this.synth.loadVoice(parseDx7Single(message));
	}
	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.synth.render(left, right, start, count);
	}
	/** silences the voices and the controllers; a loaded bank survives, as on the real cartridge memory */
	reset(): void {
		this.synth.reset();
	}
}

/**
 * A Roland D-50 voicing MIDI through mwg's `MidiSynth` contract: notes, program changes over
 * the 16 archetype patches or over a loaded patch dump, and all-notes-off. A patch-block
 * SysEx dump (`parseD50SysEx`) replaces the program table; without one, programs use the
 * fitted archetypes. Approximations, as everywhere in the LA model: no partial reserve, no
 * pitch bend, timbre dumps are read as patch data only.
 */
export class RetroD50Synth implements MidiSynth {
	readonly sampleRate: number;
	private readonly synth: D50Synth;
	private patches: readonly D50SysExPatch[] = [];
	constructor(sampleRate = 44100) {
		this.sampleRate = sampleRate;
		this.synth = new D50Synth({ sampleRate });
		this.synth.selectPreset(0);
	}
	event(status: number, data1: number, data2: number): void {
		switch (status & 0xf0) {
			case 0x80:
				this.synth.noteOff(data1);
				break;
			case 0x90:
				if (data2 > 0) this.synth.noteOn(data1, data2);
				else this.synth.noteOff(data1);
				break;
			case 0xb0:
				if (data1 === 120 || data1 === 123) for (let note = 0; note < 128; note++) this.synth.noteOff(note);
				break;
			case 0xc0:
				if (this.patches.length) this.synth.loadPatch(this.patches[data1 % this.patches.length].patch);
				else this.synth.selectPreset(data1 % D50_PRESETS.length);
				break;
		}
	}
	sysex(bytes: Uint8Array): void {
		try {
			const patches = parseD50SysEx(asSystemExclusive(bytes));
			if (!patches.length) return;
			this.patches = patches;
			this.synth.loadPatch(patches[0].patch);
		} catch {
			// not a D-50 patch dump: the way of the hardware, which ignores what it does not own
		}
	}
	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.synth.render(left, right, start, count);
	}
	/** silences the voices; a loaded patch dump survives, as on the real synth's memory */
	reset(): void {
		this.synth.reset();
	}
}

/**
 * The retro engines by the name content asks them with: `retro:mt32` (ROM-free LA model),
 * `retro:dx7` (FM 6 operators) and `retro:d50` (LA), all playable through mwg's MIDI file
 * renderers once registered.
 */
export const retroMidiEngines: Readonly<Record<string, MidiSynthFactory>> = Object.freeze({
	'retro:mt32': mt32Engine,
	'retro:dx7': (sampleRate) => new RetroDx7Synth(sampleRate),
	'retro:d50': (sampleRate) => new RetroD50Synth(sampleRate),
});

/**
 * Registers every retro engine with mwg's MIDI engine registry, so content can ask
 * `synth: "retro:mt32"` and `resolveMidiSynth` can voice files through it. Dependency
 * injected like the Hatari backend — `registerRetroMidiEngines(registerMidiSynth)` from
 * `@datamoc/mwg/audio` — so this package never imports mwg at runtime. Returns the names.
 */
export function registerRetroMidiEngines(register: (name: string, factory: MidiSynthFactory) => void): string[] {
	for (const [name, factory] of Object.entries(retroMidiEngines)) register(name, factory);
	return Object.keys(retroMidiEngines);
}

/** the mirror of {@link registerRetroMidiEngines}, over `unregisterMidiSynth`; returns the names it removed */
export function unregisterRetroMidiEngines(unregister: (name: string) => boolean): string[] {
	return Object.keys(retroMidiEngines).filter((name) => unregister(name));
}

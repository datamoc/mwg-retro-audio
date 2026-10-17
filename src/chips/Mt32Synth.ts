import type { Chip } from './Chip.ts';
import { D50Synth, D50_ATTACKS, type D50Patch } from './historical.ts';

/**
 * Roland MT-32 played by the ROM-free LA model: a drop-in for the `LaRomProvider` socket of `Mt32Session`
 * (`session.attach(new Mt32Synth(rate))`), running in a browser with no ROM and no native program.
 *
 * Default part layout of the MT-32: parts 1-8 on MIDI channels 2-9 (indices 1-8), the rhythm part on channel 10
 * (index 9). Each melodic part is a `D50Synth`; a program change (0-127) picks one of its presets by family of eight
 * (the MT-32 lays its patches out like General MIDI). The rhythm part plays one-shot attacks from the fitted attack bank
 * by key number. Approximations, all of them: the factory timbres are not reproduced, the timbre and patch SysEx are
 * recorded by `Mt32Session` but **not converted** into LA parameters, pitch bend and partial reserve are ignored.
 */

/** D50 preset used by each of the sixteen families of eight programs (pianos, chromatic percussion, organs, ...) */
const FAMILY_PRESET = [4, 1, 6, 4, 3, 2, 2, 3, 5, 5, 3, 0, 1, 1, 4, 0] as const;

const AMP: [number, number][] = [
	[0, 1],
	[0.8, 0.5],
];

export class Mt32Synth implements Chip {
	readonly id = 'mt32';
	readonly name = 'Roland MT-32 (LA model, no ROM)';
	readonly channels = 9;
	readonly clock = 0;
	readonly sampleRate: number;
	private readonly parts: D50Synth[] = [];
	private readonly drums: D50Synth;
	private readonly volume = new Float32Array(16).fill(1);

	constructor(sampleRate = 44100) {
		this.sampleRate = sampleRate;
		for (let i = 0; i < 9; i++) this.parts.push(new D50Synth({ sampleRate, level: 0.2 }));
		this.drums = new D50Synth({ sampleRate, level: 0.25 });
		this.parts.forEach((p) => p.selectPreset(FAMILY_PRESET[0]));
	}

	/** the synth playing part `index` (0-8: channels 1-9 in 0-based MIDI numbering, so part 1 is index 1), to load a patch */
	part(index: number): D50Synth {
		return this.parts[index];
	}

	/** the MT-32 SysEx are kept by `Mt32Session`; timbre data is not converted (see the header) */
	sysex(_message: Uint8Array): void {}

	/** the `MidiSink` face of the synth, for `MidiPlayer` */
	get chip(): Chip {
		return this;
	}

	event(status: number, data1: number, data2: number): void {
		this.midi(status, data1, data2);
	}

	reset(): void {
		for (const p of [...this.parts, this.drums]) p.reset();
		this.parts.forEach((p) => p.selectPreset(FAMILY_PRESET[0]));
		this.volume.fill(1);
	}

	write(): void {}

	read(): number {
		return 0;
	}

	setMuted(channel: number, muted: boolean): void {
		(this.parts[channel] ?? this.drums).setMuted(0, muted);
	}

	midi(status: number, data1: number, data2: number): void {
		const channel = status & 15;
		const kind = status & 0xf0;
		if (channel === 9) return this.rhythm(kind, data1, data2);
		const part = this.parts[channel];
		if (!part) return;
		if (kind === 0x90 && data2 > 0) part.noteOn(data1, data2);
		else if (kind === 0x80 || kind === 0x90) part.noteOff(data1);
		else if (kind === 0xc0) part.selectPreset(FAMILY_PRESET[(data1 & 127) >> 3]);
		else if (kind === 0xb0) {
			if (data1 === 7) this.volume[channel] = data2 / 127;
			else if (data1 === 123 || data1 === 120) for (let n = 0; n < 128; n++) part.noteOff(n);
		}
	}

	private rhythm(kind: number, note: number, velocity: number): void {
		if (kind === 0x90 && velocity > 0) {
			this.drums.loadPatch(this.drumPatch(note));
			this.drums.noteOn(60, velocity);
		}
	}

	/** a one-shot attack chosen by the key number, nothing else: the LA rhythm part is also made of short PCM attacks */
	private drumPatch(note: number): D50Patch {
		return {
			tones: [
				{
					structure: 1,
					partials: [{ wave: 'attack', attack: note % D50_ATTACKS.length, cutoff: 16000, amp: AMP }],
				},
			],
			release: 0.05,
		};
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		for (const p of this.parts) p.render(left, right, start, count);
		this.drums.render(left, right, start, count);
	}
}

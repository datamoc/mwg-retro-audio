import type { MidiEvent } from '../formats/midi.ts';
import { writeSmf, type WriteSmfOptions } from '../formats/midiWrite.ts';
import type { DrumVoice } from '../sfx/DrumMachine.ts';
import { planCue, type ComposeHooks, type ComposeOptions } from './composeCue.ts';
import type { StyleSpec, Timbre } from './styles.ts';

/** General MIDI channels of the parts; the drums are on the rhythm channel */
const CHANNELS = { bass: 0, chords: 1, lead: 2, drums: 9 } as const;

/** General MIDI drum notes of the drum machine's voices */
const DRUM_NOTES: Readonly<Record<DrumVoice, number>> = {
	kick: 36,
	snare: 38,
	clap: 39,
	hat: 42,
	tom: 45,
	openHat: 46,
};

/** General MIDI programs standing for the cue's voices (0-based, as in a program change message) */
const LEAD_PROGRAMS: Readonly<Record<Timbre, number>> = { saw: 81, pulse: 80, square: 80, triangle: 73, fm: 4 };

const VELOCITY = { bass: 105, chords: 62, lead: 95 } as const;

export interface ScoreOptions extends ComposeOptions {
	/** write the drum hits on channel 10 (default true) */
	drums?: boolean;
	/** override a part's General MIDI program (0 to 127); the default follows the style's instruments */
	programs?: Partial<Record<'bass' | 'chords' | 'lead', number>>;
}

/** The music of a cue as notes, before any sound is made */
export interface Score {
	/** timed channel messages in seconds: program changes, then notes (bass 1, chords 2, lead 3, drums 10) */
	events: MidiEvent[];
	/** tempo in beats per minute */
	tempo: number;
	bars: number;
	/** the length of the loop in seconds: a render of the events lasts longer, because notes ring out after it */
	seconds: number;
	style: StyleSpec;
	seed: number | string;
	/** options for `writeSmf` that keep the tempo of the cue, so that a sixteenth note is a whole number of ticks */
	file: WriteSmfOptions;
}

const bassProgram = (style: StyleSpec): number => (style.instruments.bass === 'fm' ? 39 : 38);
const chordProgram = (style: StyleSpec): number =>
	style.instruments.chords === 'pad' ? 89 : style.instruments.chords === 'stabs' ? 62 : 80;

/**
 * Compose the cue as notes instead of samples: the same progression, bass, chords, drums and lead motif as
 * {@link composeCue} for the same style, scene and seed, as timed MIDI messages. Voice the result with any engine,
 * for instance through `renderNotesAsync` (`@datamoc/mwg-retro-audio/mwg`) on a worker, or save it with `writeSmf`.
 * The voice line (speech or singing) is not music in the MIDI sense and is left out: render it with `composeCue`.
 * Notes ring past the end of the loop: pass the render to {@link foldLoop} to make it loop seamlessly.
 */
export function composeNotes(options: ScoreOptions, hooks: ComposeHooks = {}): Score {
	hooks.onProgress?.(0);
	const plan = planCue(options);
	const { style, stepSeconds } = plan;
	const programs = {
		bass: options.programs?.bass ?? bassProgram(style),
		chords: options.programs?.chords ?? chordProgram(style),
		lead: options.programs?.lead ?? LEAD_PROGRAMS[style.instruments.lead],
	};
	const events: MidiEvent[] = (['bass', 'chords', 'lead'] as const).map((part) => ({
		time: 0,
		status: 0xc0 | CHANNELS[part],
		data1: programs[part],
		data2: 0,
	}));
	const timed: Array<MidiEvent & { off: boolean }> = [];
	const add = (channel: number, note: number, velocity: number, start: number, length: number): void => {
		// a gate a little shorter than the note, so that the same pitch struck again never meets its own release
		const end = start + length * 0.97;
		timed.push({ time: start, status: 0x90 | channel, data1: note, data2: velocity, off: false });
		timed.push({ time: end, status: 0x80 | channel, data1: note, data2: 0, off: true });
	};
	for (const note of plan.notes)
		add(
			CHANNELS[note.part],
			note.midi,
			VELOCITY[note.part],
			(note.bar * 16 + note.step) * stepSeconds,
			note.seconds,
		);
	if (options.drums !== false)
		for (const hit of plan.hits)
			add(CHANNELS.drums, DRUM_NOTES[hit.voice], Math.round(127 * (hit.velocity ?? 0.7)), hit.time, 0.05);
	// releases before strikes at the same instant
	timed.sort((a, b) => a.time - b.time || Number(b.off) - Number(a.off));
	for (const { off: _off, ...event } of timed) events.push(event);
	hooks.onProgress?.(1);
	return {
		events,
		tempo: style.tempo,
		bars: plan.bars,
		seconds: plan.total / plan.rate,
		style,
		seed: options.seed,
		file: { ticksPerQuarter: 480, tempo: Math.round(60e6 / style.tempo), title: `${style.name} ${options.seed}` },
	};
}

/** The score as a Standard MIDI File, with the tempo of the cue */
export function scoreToMidiFile(score: Score): Uint8Array<ArrayBuffer> {
	return writeSmf(score.events, score.file);
}

/** Stereo samples with their rate */
export interface StereoBuffer {
	left: Float32Array;
	right: Float32Array;
	sampleRate: number;
}

/** A buffer that loops over its whole length, in the shape of mwg's `RenderedMidi` (so `toAudioBuffer` takes it) */
export interface LoopedBuffer extends StereoBuffer {
	loopStart: number;
	loopEnd: number;
	duration: number;
}

/**
 * Make a render of a score loop: what rings past `seconds` is added back to the start, as the loop mixer of
 * `composeCue` does, and the result has exactly the loop's length. Without this the end of the last notes is cut off
 * and a loop clicks.
 */
export function foldLoop(rendered: StereoBuffer, seconds: number): LoopedBuffer {
	const length = Math.max(1, Math.round(seconds * rendered.sampleRate));
	const left = new Float32Array(length);
	const right = new Float32Array(length);
	const source = Math.min(rendered.left.length, rendered.right.length);
	for (let i = 0; i < source; i++) {
		left[i % length] += rendered.left[i];
		right[i % length] += rendered.right[i];
	}
	const duration = length / rendered.sampleRate;
	return { sampleRate: rendered.sampleRate, left, right, loopStart: 0, loopEnd: duration, duration };
}

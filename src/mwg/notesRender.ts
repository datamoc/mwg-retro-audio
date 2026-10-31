import type { MidiFile, RenderMidiAsyncOptions, RenderedMidi, TimedMidiMessage } from '@datamoc/mwg/audio';
import type { MidiEvent } from '../formats/midi.ts';

/** the two functions of `@datamoc/mwg/audio` this needs, injected so that this package never imports mwg at runtime */
export interface NotesRenderer {
	renderMidiToBufferAsync(midi: MidiFile, options?: RenderMidiAsyncOptions): Promise<RenderedMidi>;
	midiFileFromTimedMessages(messages: readonly TimedMidiMessage[], options?: { loopStart?: number }): MidiFile;
}

export interface RenderNotesAsyncOptions extends RenderMidiAsyncOptions {
	/** seconds the loop jumps back to, written as the file's loop marker (default: none) */
	loopStart?: number;
}

/**
 * Renders timed notes (a recording, a generated phrase, an arpeggio made by code) to audio samples without blocking
 * the calling thread: mwg's `midiFileFromTimedMessages` turns them into a `MidiFile` (no Standard MIDI File in
 * between, times kept to the microsecond) and `renderMidiToBufferAsync` voices it with the requested engine. An
 * engine registered with {@link registerRetroWorkerMidiEngines} runs on a worker; `signal` cancels the render.
 * `time` is in seconds, `status` a channel message: note on/off, program, controller or pitch bend. Pass
 * `import * as audio from '@datamoc/mwg/audio'` as `mwg`. The result is what `renderMidiToBufferAsync` returns: stereo
 * buffers ready for `toAudioBuffer` or a `StreamChannel`.
 *
 * Rejects for an invalid time and, like `renderMidiToBufferAsync`, with 'MIDI file has no notes' for a list without a
 * note-on.
 */
export function renderNotesAsync(
	mwg: NotesRenderer,
	events: readonly MidiEvent[],
	options: RenderNotesAsyncOptions = {},
): Promise<RenderedMidi> {
	const { loopStart, ...renderOptions } = options;
	try {
		for (const event of events)
			if (!Number.isFinite(event.time) || event.time < 0)
				throw new RangeError('event time must be a finite number of seconds');
		return mwg.renderMidiToBufferAsync(mwg.midiFileFromTimedMessages(events, { loopStart }), renderOptions);
	} catch (error) {
		return Promise.reject(error);
	}
}

import type { RetroPlayer } from '../players/Player.ts';
import { RetroStream, type RetroStreamOptions } from './RetroStream.ts';

/** The native context and connection function exposed by Tone.js; Tone remains an optional dependency. */
export interface ToneAudioBridge<Destination> {
	getContext(): { rawContext: BaseAudioContext };
	connect(source: AudioNode, destination: Destination): unknown;
}

/** Route a retro stream through a Tone node, without an additional direct-to-speaker connection. */
export function createToneStream<Destination>(
	tone: ToneAudioBridge<Destination>,
	destination: Destination,
	player: RetroPlayer,
	options: RetroStreamOptions = {},
): { stream: RetroStream; input: GainNode; dispose(): void } {
	const context = tone.getContext().rawContext;
	if (!('resume' in context)) throw new Error('Tone integration requires a live AudioContext');
	const input = context.createGain();
	let stream: RetroStream;
	try {
		stream = new RetroStream(context as AudioContext, input, player, options);
		tone.connect(input, destination);
	} catch (error) {
		input.disconnect();
		throw error;
	}
	return {
		stream,
		input,
		dispose(): void {
			stream.stop();
			input.disconnect();
		},
	};
}

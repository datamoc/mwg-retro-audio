import type { SpeechLanguage } from './g2p.ts';
import { speakText, type SpeakOptions } from './TextToSpeech.ts';

/** One line of dialogue to synthesize */
export interface SpeechRequest {
	text: string;
	/** language of the text (default French) */
	language?: SpeechLanguage;
	options?: SpeakOptions;
	/** peak level of the result, 0..1 (default 0.8) */
	level?: number;
}

/** Mono samples of a synthesized line */
export interface SpeechResult {
	samples: Float32Array;
	sampleRate: number;
}

/** Synthesize a line of dialogue: the same pure function runs in the worker and, without one, in the caller */
export function synthesizeSpeech(request: SpeechRequest): SpeechResult {
	const sampleRate = request.options?.sampleRate ?? 48000;
	const samples = speakText(request.text, request.language ?? 'fr', { ...request.options, sampleRate });
	let peak = 0;
	for (const s of samples) peak = Math.max(peak, Math.abs(s));
	const gain = peak > 0 ? (request.level ?? 0.8) / peak : 1;
	for (let i = 0; i < samples.length; i++) samples[i] *= gain;
	return { samples, sampleRate };
}

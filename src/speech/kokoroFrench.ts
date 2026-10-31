import type { KokoroTTS } from 'kokoro-js';

export const FRENCH_VOICE_URL =
	'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/4685882/voices/ff_siwis.bin';

/** Phoneme mapping adapted from Misaki's Apache-2.0 EspeakG2P (v1.0 model convention). */
export function normalizeFrenchPhonemes(ipa: string): string {
	const mappings: readonly (readonly [string, string])[] = [
		['a^ɪ', 'I'],
		['a^ʊ', 'W'],
		['d^z', 'ʣ'],
		['d^ʒ', 'ʤ'],
		['e^ɪ', 'A'],
		['o^ʊ', 'O'],
		['ə^ʊ', 'Q'],
		['s^s', 'S'],
		['t^s', 'ʦ'],
		['t^ʃ', 'ʧ'],
		['ɔ^ɪ', 'Y'],
	];
	let phonemes = ipa;
	for (const [from, to] of mappings) phonemes = phonemes.replaceAll(from, to);
	// Keep nasal combining marks: French needs them. Do not apply English r/x replacements.
	return phonemes
		.replace(/[\^\-]/gu, '')
		.replaceAll('«', '(')
		.replaceAll('»', ')')
		.trim();
}

/** Short word-bounded segments, preferring sentence boundaries. */
export function splitSpeechText(text: string): string[] {
	const result: string[] = [];
	for (const sentence of text.match(/[^.!?\n]+[.!?]*/gu) ?? []) {
		let chunk = '';
		for (const word of sentence.match(/\S+\s*/gu) ?? []) {
			if (word.trim().length > 200) throw new RangeError('Speech contains a word longer than 200 characters');
			if (chunk.length + word.length > 200 && chunk.trim()) {
				result.push(chunk.trim());
				chunk = '';
			}
			chunk += word;
		}
		if (chunk.trim()) result.push(chunk.trim());
	}
	return result;
}

export async function loadFrenchVoice(): Promise<Float32Array> {
	const response = await fetch(FRENCH_VOICE_URL, { signal: AbortSignal.timeout(30000), cache: 'force-cache' });
	if (!response.ok) throw new Error(`French voice download failed: HTTP ${response.status}`);
	const bytes = await response.arrayBuffer();
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
	if (hash !== 'a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861')
		throw new Error('French voice checksum mismatch');
	return new Float32Array(bytes);
}

export async function* renderFrench(
	runtime: KokoroTTS,
	phonemize: (text: string) => Promise<string>,
	text: string,
	speed: number,
	voice: Float32Array,
) {
	const { Tensor } = await import('@huggingface/transformers');
	if (voice.length !== 510 * 256 || voice.some((value) => !Number.isFinite(value)))
		throw new Error('Invalid French voice data');
	for (const chunk of splitSpeechText(text)) {
		const phonemes = normalizeFrenchPhonemes(await phonemize(chunk));
		if (!phonemes) throw new Error('French phonemizer returned no phonemes');
		const { input_ids } = runtime.tokenizer(phonemes, { truncation: false });
		const count = input_ids.dims.at(-1)! - 2;
		if (count > 510) throw new RangeError('French phrase exceeds the model token limit; use a shorter phrase');
		const index = Math.min(509, Math.max(0, count));
		const { waveform } = await runtime.model({
			input_ids,
			style: new Tensor('float32', voice.slice(index * 256, (index + 1) * 256), [1, 256]),
			speed: new Tensor('float32', [speed], [1]),
		});
		yield { audio: { audio: waveform.data as Float32Array, sampling_rate: 24000 } };
	}
}

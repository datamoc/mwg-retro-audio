export { FormantSynth, type FormantSynthOptions, type SourceShape, type SpeechFrame } from './FormantSynth.ts';
export { PHONEMES, type Phoneme } from './phonemes.ts';
export {
	sing,
	singLyrics,
	singText,
	speakPhonemes,
	speakText,
	type MelodyNote,
	type SpeakOptions,
	type SungSyllable,
} from './TextToSpeech.ts';
export { phonemesToSyllables, textToPhonemes, type SpeechLanguage } from './g2p.ts';
export { vocode, type VocoderOptions } from './Vocoder.ts';
export { SPEECH_REGISTERS, SpeechChip } from './SpeechChip.ts';
export {
	SpeechService,
	type SpeakLineOptions,
	type SpeechServiceOptions,
	type SpeechWorkerLike,
} from './SpeechService.ts';
export { synthesizeSpeech, type SpeechRequest, type SpeechResult } from './speechRender.ts';
export { BrowserSpeech, type BrowserSpeakOptions } from './BrowserSpeech.ts';

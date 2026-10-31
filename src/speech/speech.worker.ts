// Entry of the speech Web Worker: receives `{ id, request }`, answers `{ id, success, samples, sampleRate }` with the
// samples transferred (not copied), or `{ id, success: false, error }`. `SpeechService` starts it as a module worker.
import { synthesizeSpeech, type SpeechRequest } from './speechRender.ts';

interface WorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
	const { id, request } = event.data as { id: number; request: SpeechRequest };
	try {
		const result = synthesizeSpeech(request);
		scope.postMessage({ id, success: true, samples: result.samples, sampleRate: result.sampleRate }, [
			result.samples.buffer as ArrayBuffer,
		]);
	} catch (error) {
		scope.postMessage({ id, success: false, error: String(error) });
	}
};

// Entry of the render Web Worker: `{ id, request }` in (a file and how to render it), progress messages and one
// result (its buffers transferred) out. `renderFileAsync` starts it as a module worker.
import { handleRenderMessage } from './renderJob.ts';

interface WorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
	void handleRenderMessage(event.data, (message, transfer) => scope.postMessage(message, transfer));
};

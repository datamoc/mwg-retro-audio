// Entry of the compose Web Worker: `{ id, request }` in, progress messages and one result (its buffers transferred)
// out. `composeCueAsync` and `composeNotesAsync` start it as a module worker.
import { handleComposeMessage } from './composeJob.ts';

interface WorkerScope {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
	void handleComposeMessage(event.data, (message, transfer) => scope.postMessage(message, transfer));
};

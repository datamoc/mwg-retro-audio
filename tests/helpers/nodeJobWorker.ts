import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { JobWorkerLike } from '../../src/jobs/index.ts';

type Listener = (event: { data?: unknown }) => void;
type NodeEvent = 'message' | 'error' | 'messageerror';

/**
 * A real thread running a job handler of `src/`, shaped like a Web Worker, so that a test proves the off-thread path:
 * the request is cloned, the answer comes from another thread and its buffers are transferred.
 */
export function nodeJobWorker(module: string, handler: string): JobWorkerLike & { terminated: boolean } {
	const url = pathToFileURL(resolve(import.meta.dirname, '..', '..', 'src', module)).href;
	const worker = new Worker(
		`const { parentPort } = require('node:worker_threads');
require('tsx/esm/api').register();
import(${JSON.stringify(url)}).then((m) => parentPort.on('message', (d) => m[${JSON.stringify(handler)}](d, (msg, tr) => parentPort.postMessage(msg, tr))));`,
		{ eval: true },
	);
	const wrapped = new Map<Listener, (value: unknown) => void>();
	const host = {
		terminated: false,
		postMessage: (message: unknown) => worker.postMessage(message),
		addEventListener(type: NodeEvent, listener: Listener) {
			const adapt = (value: unknown): void =>
				listener(type === 'message' ? { data: value } : ({ message: (value as Error)?.message } as never));
			wrapped.set(listener, adapt);
			worker.on(type, adapt);
		},
		removeEventListener(type: NodeEvent, listener: Listener) {
			const adapt = wrapped.get(listener);
			if (adapt) worker.off(type, adapt);
		},
		terminate() {
			host.terminated = true;
			void worker.terminate();
		},
	};
	return host as JobWorkerLike & { terminated: boolean };
}

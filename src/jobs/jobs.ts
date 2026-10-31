// Jobs for a worker: a request goes out, progress and one result come back, the buffers of the result are transferred
// rather than copied. The same function runs in the worker and, without one, in the calling thread, so the two cannot
// give different audio. `SpeechService` does the same for dialogue lines.

/** The part of a Web Worker a job uses, so that a test or another host (Node `worker_threads`) can supply its own */
export interface JobWorkerLike {
	postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
	addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: { data?: unknown }) => void): void;
	removeEventListener(
		type: 'message' | 'error' | 'messageerror',
		listener: (event: { data?: unknown }) => void,
	): void;
	terminate(): void;
}

export interface JobOptions {
	/** abandons the job: the promise rejects with the signal's reason and the worker is terminated */
	signal?: AbortSignal;
	/** the share of the job done so far, 0 to 1 */
	onProgress?: (fraction: number) => void;
	/**
	 * Where the job runs: a function that makes a worker (one per job, terminated at the end), `false` for the calling
	 * thread, or nothing for the default: the module worker of the job when the host has `Worker`, the calling thread
	 * otherwise (Node, tests)
	 */
	worker?: (() => JobWorkerLike) | false;
}

/** what a runner answers: the result and the buffers of it that can be transferred */
export interface JobOutput<Result> {
	result: Result;
	transfer: ArrayBuffer[];
}

/** a function that does the job, reporting progress; the same one serves the worker and the calling thread */
export type JobRunner<Request, Result> = (
	request: Request,
	onProgress: (fraction: number) => void,
) => JobOutput<Result> | Promise<JobOutput<Result>>;

/** what travels from the worker */
export type JobReply =
	| { id: number; type: 'progress'; fraction: number }
	| { id: number; type: 'done'; result: unknown }
	| { id: number; type: 'error'; message: string };

const ABORTED = (signal: AbortSignal): unknown =>
	signal.reason ?? Object.assign(new Error('job aborted'), { name: 'AbortError' });

/**
 * The worker side: answer one `{ id, request }` message with progress messages and one `done` or `error`, using the
 * runner. A host calls it from its message handler with its own `post`.
 */
export async function answerJob<Request, Result>(
	data: unknown,
	run: JobRunner<Request, Result>,
	post: (message: JobReply, transfer?: ArrayBuffer[]) => void,
): Promise<void> {
	const { id, request } = data as { id: number; request: Request };
	try {
		const { result, transfer } = await run(request, (fraction) => post({ id, type: 'progress', fraction }));
		post({ id, type: 'done', result }, transfer);
	} catch (error) {
		post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
	}
}

let nextId = 1;

/**
 * The calling side: run one job in a fresh worker, or in this thread. `makeDefault` makes the default worker; it is
 * written at the call site as `new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })` so that
 * bundlers find the file.
 */
export function runJob<Request, Result>(
	request: Request,
	run: JobRunner<Request, Result>,
	makeDefault: () => JobWorkerLike,
	options: JobOptions = {},
): Promise<Result> {
	const { signal } = options;
	if (signal?.aborted) return Promise.reject(ABORTED(signal));
	let worker: JobWorkerLike | undefined;
	if (options.worker !== false) {
		try {
			if (options.worker) worker = options.worker();
			else if (typeof Worker !== 'undefined') worker = makeDefault();
		} catch {
			worker = undefined; // no worker available here: run in the calling thread
		}
	}
	return worker ? inWorker(worker, request, options) : inThread(request, run, options);
}

function inWorker<Request, Result>(worker: JobWorkerLike, request: Request, options: JobOptions): Promise<Result> {
	const { signal, onProgress } = options;
	const id = nextId++;
	return new Promise<Result>((resolve, reject) => {
		const finish = (settle: () => void): void => {
			signal?.removeEventListener('abort', abort);
			worker.removeEventListener('message', onMessage);
			worker.removeEventListener('error', onError);
			worker.removeEventListener('messageerror', onError);
			worker.terminate();
			settle();
		};
		const abort = (): void => finish(() => reject(ABORTED(signal!)));
		const onError = (event: { data?: unknown }): void =>
			finish(() =>
				reject(new Error(String((event as { message?: unknown }).message ?? 'the job worker failed'))),
			);
		const onMessage = (event: { data?: unknown }): void => {
			const reply = event.data as JobReply | undefined;
			if (!reply || reply.id !== id) return;
			if (reply.type === 'progress') onProgress?.(reply.fraction);
			else if (reply.type === 'done') finish(() => resolve(reply.result as Result));
			else finish(() => reject(new Error(reply.message)));
		};
		signal?.addEventListener('abort', abort, { once: true });
		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError);
		worker.addEventListener('messageerror', onError);
		worker.postMessage({ id, request });
	});
}

/** without a worker: give the frame back first, then run; a cancel takes effect at the next progress report */
function inThread<Request, Result>(
	request: Request,
	run: JobRunner<Request, Result>,
	options: JobOptions,
): Promise<Result> {
	const { signal, onProgress } = options;
	return new Promise<Result>((resolve, reject) => {
		setTimeout(() => {
			if (signal?.aborted) return reject(ABORTED(signal));
			Promise.resolve()
				.then(() =>
					run(request, (fraction) => {
						if (signal?.aborted) throw ABORTED(signal);
						onProgress?.(fraction);
					}),
				)
				.then(({ result }) => {
					if (signal?.aborted) throw ABORTED(signal);
					resolve(result);
				}, reject);
		}, 0);
	});
}

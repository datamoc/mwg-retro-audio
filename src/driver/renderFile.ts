import type { LoadFileOptions } from '../formats/load.ts';
import { runJob, type JobOptions, type JobRunner, type JobWorkerLike } from '../jobs/jobs.ts';
import type { RenderOptions, RenderResult } from './Renderer.ts';
import type { RenderFileRequest } from './renderJob.ts';

export interface RenderFileOptions extends JobOptions, RenderOptions {
	/** how to load the file: its name, the instrument banks, the PSID region... plain data only */
	load?: LoadFileOptions;
}

/** The default worker: written as one expression so that bundlers (Vite, webpack, esbuild) find and package the file */
function defaultWorker(): JobWorkerLike {
	return new Worker(new URL('./render.worker.js', import.meta.url), { type: 'module' }) as unknown as JobWorkerLike;
}

/** without a worker the formats are loaded only when a render needs them, so that importing this file stays light */
const runLazily: JobRunner<RenderFileRequest, RenderResult> = async (request, onProgress) =>
	(await import('./renderJob.ts')).runRenderRequest(request, onProgress);

/**
 * `renderPlayerAsync` for a file, in a worker: the file is loaded, played and rendered off the main thread, the stereo
 * buffers come back transferred. The audio equals `renderPlayerAsync(loadFile(bytes, load), render)`. A player is a live
 * object that cannot cross to a worker, which is why this takes the file: keep `renderPlayerAsync` for a player you
 * built yourself. `onProgress` reports 0..1, `signal` cancels and terminates the worker. Without `Worker` (Node) it
 * renders in the calling thread.
 */
export function renderFileAsync(bytes: Uint8Array, options: RenderFileOptions = {}): Promise<RenderResult> {
	const { load, signal, onProgress, worker, ...render } = options;
	if (load && Object.values(load).some((value) => typeof value === 'function'))
		return Promise.reject(
			new TypeError(
				'renderFileAsync cannot send a function option (such as chipFactory) to a worker: use renderPlayerAsync',
			),
		);
	return runJob({ bytes, load, render }, runLazily, defaultWorker, { signal, onProgress, worker });
}

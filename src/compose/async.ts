import { runJob, type JobOptions, type JobWorkerLike } from '../jobs/jobs.ts';
import type { ComposeOptions, Cue } from './composeCue.ts';
import { runComposeRequest, type ComposeRequest } from './composeJob.ts';
import type { Score, ScoreOptions } from './score.ts';

/** The default worker: written as one expression so that bundlers (Vite, webpack, esbuild) find and package the file */
function defaultWorker(): JobWorkerLike {
	return new Worker(new URL('./compose.worker.js', import.meta.url), { type: 'module' }) as unknown as JobWorkerLike;
}

const run = <Result>(request: ComposeRequest, options: JobOptions): Promise<Result> =>
	runJob(request, runComposeRequest, defaultWorker, options) as Promise<Result>;

/**
 * `composeCue` off the main thread: the cue is composed and rendered in a worker and its buffers come back
 * transferred, ready for `toAudioBuffer`. The same cue as `composeCue` gives, sample for sample. Without `Worker` (Node)
 * it runs in the calling thread after a frame. `onProgress` reports 0..1, `signal` cancels (and terminates the worker).
 * Options must be plain data: a custom `StyleSpec`, `voiceSamples` and text are fine.
 */
export function composeCueAsync(options: ComposeOptions, jobOptions: JobOptions = {}): Promise<Cue> {
	return run<Cue>({ kind: 'cue', options }, jobOptions);
}

/**
 * The same music as `composeCueAsync` as notes ({@link composeNotes}), composed in a worker. Voice them with any engine,
 * for instance `renderNotesAsync` of `@datamoc/mwg-retro-audio/mwg`, then {@link foldLoop} the render to loop it.
 */
export function composeNotesAsync(options: ScoreOptions, jobOptions: JobOptions = {}): Promise<Score> {
	return run<Score>({ kind: 'notes', options }, jobOptions);
}

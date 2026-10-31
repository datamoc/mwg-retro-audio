import { answerJob, type JobReply, type JobRunner } from '../jobs/jobs.ts';
import { composeCue, type ComposeOptions, type Cue } from './composeCue.ts';
import { composeNotes, type Score, type ScoreOptions } from './score.ts';

/** what the compose worker is asked for */
export type ComposeRequest = { kind: 'cue'; options: ComposeOptions } | { kind: 'notes'; options: ScoreOptions };

/** the buffers of a cue that can cross to the caller without a copy */
function cueBuffers(cue: Cue): ArrayBuffer[] {
	const arrays = [cue.left, cue.right, cue.voiceTrack?.left, cue.voiceTrack?.right];
	return arrays.flatMap((array) => (array ? [array.buffer as ArrayBuffer] : []));
}

/** does the work of a request: the same function in the worker and in the calling thread */
export const runComposeRequest: JobRunner<ComposeRequest, Cue | Score> = (request, onProgress) => {
	if (request.kind === 'notes') return { result: composeNotes(request.options, { onProgress }), transfer: [] };
	const cue = composeCue(request.options, { onProgress });
	return { result: cue, transfer: cueBuffers(cue) };
};

/** the message handler of the compose worker (and of any host that runs it, such as a `worker_threads` wrapper) */
export const handleComposeMessage = (
	data: unknown,
	post: (message: JobReply, transfer?: ArrayBuffer[]) => void,
): Promise<void> => answerJob(data, runComposeRequest, post);

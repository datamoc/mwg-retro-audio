import { loadFile, type LoadFileOptions } from '../formats/load.ts';
import { answerJob, type JobReply, type JobRunner } from '../jobs/jobs.ts';
import { renderPlayerAsync, type RenderOptions, type RenderResult } from './Renderer.ts';

/** what the render worker is asked for: a file, how to load it, how long to render */
export interface RenderFileRequest {
	bytes: Uint8Array;
	load?: LoadFileOptions;
	render?: RenderOptions;
}

/** does the work of a request: the same function in the worker and in the calling thread */
export const runRenderRequest: JobRunner<RenderFileRequest, RenderResult> = async (request, onProgress) => {
	const player = loadFile(request.bytes, request.load);
	const result = await renderPlayerAsync(player, { ...request.render, onProgress });
	return { result, transfer: [result.left.buffer as ArrayBuffer, result.right.buffer as ArrayBuffer] };
};

/** the message handler of the render worker (and of any host that runs it, such as a `worker_threads` wrapper) */
export const handleRenderMessage = (
	data: unknown,
	post: (message: JobReply, transfer?: ArrayBuffer[]) => void,
): Promise<void> => answerJob(data, runRenderRequest, post);

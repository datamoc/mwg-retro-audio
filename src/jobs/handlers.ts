// The message handlers of the two job workers, for a host that runs them itself (Node `worker_threads`, a test): call
// one with each `{ id, request }` message and a `post` that forwards its answers to the caller.
export { handleComposeMessage } from '../compose/composeJob.ts';
export { handleRenderMessage } from '../driver/renderJob.ts';

import type { MidiSynthFactory } from '@datamoc/mwg/audio';

/**
 * Registers engines for synchronous use on this thread and, for each one that has a packaged core, as a worker engine,
 * so `renderMidiToBufferAsync(midi, { synth: 'retro:d50' })` constructs and renders it off the main thread
 * (MWG 0.52 and later, which takes the core as source text). Dependency injected like {@link registerRetroMidiEngines}:
 * pass mwg's `registerMidiSynth`, the engines to register and `retroCoreSource` from
 * `@datamoc/mwg-retro-audio/mwg/worker-cores` (which holds every core; import `.../worker-cores/<name>` and pass a
 * one-entry lookup to keep a bundle small). An engine without a core is registered for this thread only. Returns the
 * names that got a worker engine.
 */
export function registerRetroWorkerMidiEngines(
	register: (name: string, factory: MidiSynthFactory, workerFactory?: string) => void,
	engines: Readonly<Record<string, MidiSynthFactory>>,
	coreSource: (name: string) => string | undefined,
): string[] {
	const hosted: string[] = [];
	for (const [name, factory] of Object.entries(engines)) {
		const source = coreSource(name);
		register(name, factory, source);
		if (source !== undefined) hosted.push(name);
	}
	return hosted;
}

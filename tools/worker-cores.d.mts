export function coreFileName(name: string): string;
export function coreSources(where: {
	root: string;
	extension: '.ts' | '.js';
	load: (path: string) => Promise<Record<string, unknown>>;
}): Promise<Map<string, string>>;
export function workerProblems(text: string): string[];

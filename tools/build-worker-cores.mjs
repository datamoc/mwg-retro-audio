import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { coreFileName, coreSources, workerProblems } from './worker-cores.mjs';

// After `tsc`: writes dist/mwg/worker-cores.js (the names and a sync `retroCoreSource`) and one module per engine
// under dist/mwg/worker-cores/, so a game can import a single engine's text without the others.
const root = resolve(import.meta.dirname, '..', 'dist');
const sources = await coreSources({
	root,
	extension: '.js',
	load: (module) => import(pathToFileURL(resolve(root, `${module}.js`)).href),
});
const folder = resolve(root, 'mwg', 'worker-cores');
await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
const names = [...sources.keys()].sort();
for (const name of names) {
	const text = sources.get(name);
	const problems = workerProblems(text);
	if (problems.length) throw new Error(`${name}: not fit for a Worker (${problems.join(', ')})`);
	const file = coreFileName(name);
	await writeFile(
		resolve(folder, `${file}.js`),
		`// ${name}: a factory expression \`(sampleRate) => MidiSynth\`, self-contained, for mwg's AudioCoreHost factorySource\nexport default ${JSON.stringify(text)};\n`,
	);
	await writeFile(resolve(folder, `${file}.d.ts`), 'declare const source: string;\nexport default source;\n');
}
const imports = names.map((name, i) => `import core${i} from './worker-cores/${coreFileName(name)}.js';`).join('\n');
await writeFile(
	resolve(root, 'mwg', 'worker-cores.js'),
	`${imports}\n\nconst sources = {\n${names.map((name, i) => `\t${JSON.stringify(name)}: core${i},`).join('\n')}\n};\n\n` +
		`/** the engines that have a packaged core */\nexport const retroCoreNames = Object.freeze(Object.keys(sources));\n\n` +
		`/** the text of an engine's factory expression, \`undefined\` for an unknown name */\n` +
		`export function retroCoreSource(name) {\n\treturn Object.hasOwn(sources, name) ? sources[name] : undefined;\n}\n`,
);
await writeFile(
	resolve(root, 'mwg', 'worker-cores.d.ts'),
	`/** the engines that have a packaged core: \`retro:mt32\`, \`retro:dx7\`, \`retro:d50\` and one per catalogue model */\n` +
		`export declare const retroCoreNames: readonly string[];\n\n` +
		`/**\n * The text of an expression whose value is the factory \`(sampleRate) => MidiSynth\` of the engine, with every\n` +
		` * import bundled in (no import/export, eval, WebAssembly or DOM): pass it as \`factorySource\` to mwg's\n` +
		` * \`AudioCoreHost\`. \`undefined\` for a name without a core.\n */\n` +
		`export declare function retroCoreSource(name: string): string | undefined;\n`,
);
console.log(`${names.length} cores in ${folder}`);

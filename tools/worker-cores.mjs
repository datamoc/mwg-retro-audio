import { build } from 'esbuild';
import { resolve } from 'node:path';

/**
 * The synthesis cores of the MIDI engines as self-contained JavaScript text, one per engine, for mwg's
 * `AudioCoreHost` (`factorySource`): a Worker receives only text, so each text is an expression whose value is the
 * factory `(sampleRate) => MidiSynth`, with every import bundled in. No `import`/`export`, no `eval`, no WebAssembly,
 * no DOM access. The engine names are those of `retroCatalogueMidiEngines`.
 */

/** which module of the catalogue holds each family of definitions, so an engine bundles its own family only */
const FAMILIES = [
	['simpleCatalogue', 'simpleInstruments'],
	['psg', 'psgInstruments'],
	['synths', 'historicalInstruments'],
	['modelled', 'modelledInstruments'],
	['registers', 'registerInstruments'],
	['fm-registers', 'oplInstruments'],
	['fm-registers', 'opmInstruments'],
	['fm-registers', 'opnInstruments'],
	['pc-registers', 'pcInstruments'],
];

/** the entries built apart from the catalogue: they read SysEx, or share another engine */
const DEDICATED = {
	'retro:mt32': { module: 'chips/Mt32Synth', code: `import { Mt32Synth } from '$';\nexport const factory = (rate) => new Mt32Synth(rate);` },
	'retro:lapc-i': { same: 'retro:mt32' },
	'retro:dx7': { module: 'mwg/midiEngines', code: `import { RetroDx7Synth } from '$';\nexport const factory = (rate) => new RetroDx7Synth(rate);` },
	'retro:d50': { module: 'mwg/midiEngines', code: `import { RetroD50Synth } from '$';\nexport const factory = (rate) => new RetroD50Synth(rate);` },
};

/** the file name of an engine's text: `retro:simple:electric-piano` becomes `retro-simple-electric-piano` */
export const coreFileName = (name) => name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * @param {{ root: string, extension: '.ts' | '.js', load: (path: string) => Promise<Record<string, unknown>> }} where
 *   `root` is the folder holding `instruments/` and `mwg/` (`src` or `dist`), `load` imports a module of it
 * @returns {Promise<Map<string, string>>} engine name to the text of its factory expression
 */
export async function coreSources({ root, extension, load }) {
	const file = (module) => resolve(root, `${module}${extension}`).replaceAll('\\', '/');
	/** @type {Map<string, { module: string, code: string }>} */
	const entries = new Map();
	const { instrumentEngineName } = await load('mwg/instrumentEngines');
	for (const [module, exported] of FAMILIES) {
		const definitions = (await load(`instruments/${module}`))[exported];
		for (const definition of definitions) {
			const id = definition.info.id;
			entries.set(instrumentEngineName(id), {
				module,
				code:
					`import { ${exported} } from ${JSON.stringify(file(`instruments/${module}`))};\n` +
					`import { InstrumentMidiSynth } from ${JSON.stringify(file('mwg/instrumentEngines'))};\n` +
					`const definition = ${exported}.find((d) => d.info.id === ${JSON.stringify(id)});\n` +
					`export const factory = (rate) => new InstrumentMidiSynth(definition, rate);`,
			});
		}
	}
	for (const [name, entry] of Object.entries(DEDICATED))
		if (entry.same) entries.set(name, entries.get(entry.same) ?? { ...DEDICATED[entry.same], same: undefined });
		else entries.set(name, { module: entry.module, code: entry.code.replace('$', file(entry.module)) });

	const sources = new Map();
	const built = new Map();
	for (const [name, entry] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (built.has(entry.code)) {
			sources.set(name, built.get(entry.code));
			continue;
		}
		const out = await build({
			stdin: { contents: entry.code, resolveDir: root, sourcefile: `${coreFileName(name)}.js`, loader: 'js' },
			bundle: true,
			write: false,
			format: 'iife',
			globalName: '__core',
			platform: 'neutral',
			target: 'es2020',
			minify: true,
			legalComments: 'none',
			logLevel: 'error',
		});
		const text = `(() => {\n${out.outputFiles[0].text.trim()}\nreturn __core.factory;\n})()`;
		built.set(entry.code, text);
		sources.set(name, text);
	}
	return sources;
}

/** the reasons a text could not run in a Worker under mwg's default policy; empty when it is fine */
export function workerProblems(text) {
	const problems = [];
	if (/^\s*(import|export)\b/m.test(text)) problems.push('import/export statement');
	if (/\beval\s*\(/.test(text)) problems.push('eval');
	if (/\bnew Function\b/.test(text)) problems.push('new Function');
	if (/WebAssembly/.test(text)) problems.push('WebAssembly');
	if (/\b(document|window|localStorage)\b/.test(text)) problems.push('DOM access');
	return problems;
}

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const entries = {
	profile: `import { SimpleInstrument, piano } from '@datamoc/mwg-retro-audio/instruments/simple'; console.log(new SimpleInstrument(piano));`,
	chip: `import { Ym2149 } from '@datamoc/mwg-retro-audio/chips/Ym2149'; console.log(new Ym2149());`,
	chipBarrel: `import { Ym2149 } from '@datamoc/mwg-retro-audio/chips'; console.log(new Ym2149());`,
	chipRoot: `import { Ym2149 } from '@datamoc/mwg-retro-audio'; console.log(new Ym2149());`,
	catalogue: `import { instrumentCatalogue } from '@datamoc/mwg-retro-audio/instruments/catalogue'; console.log(instrumentCatalogue);`,
	mwgTargeted: `import { instrumentMidiEngines } from '@datamoc/mwg-retro-audio/mwg'; import { psgInstruments } from '@datamoc/mwg-retro-audio/instruments/psg'; console.log(instrumentMidiEngines(psgInstruments));`,
	mwgCatalogue: `import { retroCatalogueMidiEngines } from '@datamoc/mwg-retro-audio/mwg/catalogue'; console.log(retroCatalogueMidiEngines);`,
	soundFontParser: `import { parseSf2 } from '@datamoc/mwg-retro-audio/formats/soundfont'; console.log(parseSf2);`,
	soundFontInstruments: `import { soundFontInstruments } from '@datamoc/mwg-retro-audio/instruments/soundfont'; console.log(soundFontInstruments);`,
	business: `import * as chips from '@datamoc/mwg-retro-audio/chips'; import * as instruments from '@datamoc/mwg-retro-audio/instruments'; console.log(chips, instruments);`,
};
const results = {};
for (const [name, contents] of Object.entries(entries)) {
	const output = await build({
		stdin: { contents, resolveDir: root, sourcefile: `${name}.ts`, loader: 'ts' },
		bundle: true,
		format: 'esm',
		platform: 'browser',
		minify: true,
		write: false,
		metafile: true,
		treeShaking: true,
	});
	const modules = Object.entries(output.metafile.outputs).flatMap(([, file]) =>
		Object.entries(file.inputs)
			.filter(([, input]) => input.bytesInOutput > 0)
			.map(([path]) => path.replaceAll('\\', '/')),
	);
	const bytes = output.outputFiles[0].contents;
	results[name] = { bytes: bytes.length, gzipBytes: gzipSync(bytes).length, modules };
	if (name === 'profile') {
		assert(
			!modules.some((path) => path.includes('/chips/') || path.includes('/formats/')),
			'A simple profile retained chip emulators or parsers',
		);
		assert(
			!modules.some((path) => /instruments\/(catalogue|psg|synths|modelled|registers|fm-registers|pc-registers)\.js/.test(path)),
			'A single simple profile retained the catalogue or other instrument modules',
		);
		const text = output.outputFiles[0].text;
		for (const label of ['Electric piano', 'Organ', 'Guitar', 'Brass', 'Flute'])
			assert(!text.includes(`"${label}"`), `Unused profile ${label} retained`);
	}
	if (name === 'chip' || name === 'chipBarrel' || name === 'chipRoot') {
		for (const module of ['historical', 'd50Waves', 'm1Data', 'Dx7', 'Sid', 'NesApu']) {
			assert(!modules.some((path) => path.includes(module)), `Unused module ${module} retained`);
		}
		assert(!modules.some((path) => path.includes('/instruments/')), 'A single chip retained instrument layers');
	}
	if (name === 'soundFontParser') {
		assert(
			!modules.some((path) => /\/(chips|instruments|players)\//.test(path)),
			'The SoundFont reader retained chips, instruments or players',
		);
	}
	if (name === 'soundFontInstruments') {
		assert(
			!modules.some((path) => /instruments\/(catalogue|synths|modelled|registers|psg)\.js|historical|M1|MicroKorg|Dx7/.test(path)),
			'The SoundFont instruments retained the catalogue or other synthesizers',
		);
		assert(modules.some((path) => path.endsWith('chips/SoundFont.js')), 'The SoundFont player is missing');
	}
	if (name === 'mwgTargeted') {
		assert(
			!modules.some((path) => /instruments\/(catalogue|synths|modelled|registers|fm-registers|pc-registers)\.js|catalogueEngines/.test(path)),
			'The mwg entry point with a chosen instrument retained the catalogue',
		);
		assert(modules.some((path) => path.endsWith('instruments/psg.js')), 'The chosen instrument is missing');
	}
	if (name === 'mwgCatalogue') {
		assert(modules.some((path) => path.endsWith('instruments/catalogue.js')), 'The catalogue engines dropped the catalogue');
		const text = output.outputFiles[0].text;
		for (const id of ['retro:mt32', 'retro:dx7', 'retro:d50', '"ym2149"', '"pcm-dac"']) assert(text.includes(id), `Engine ${id} missing`);
	}
	if (name === 'catalogue') {
		const retainedFormats = modules.filter(
			(path) => (path.includes('/formats/') || path.includes('/players/')) && !path.endsWith('formats/dx7.js'),
		);
		assert(retainedFormats.length === 0, `The instrument catalogue retained file parsers: ${retainedFormats}`);
		for (const module of ['catalogue', 'simple', 'psg', 'synths', 'modelled', 'registers', 'fm-registers', 'pc-registers']) {
			assert(
				modules.some((path) => path.endsWith(`instruments/${module}.js`)),
				`The catalogue app dropped ${module}`,
			);
		}
		const text = output.outputFiles[0].text;
		for (const id of ['ym2149', 'pc-speaker', 'ym2612', 'apple2-speaker', 'pcm-dac', 'mockingboard'])
			assert(text.includes(`"${id}"`), `Catalogue id ${id} missing`);
	}
}
assert(results.profile.bytes < results.catalogue.bytes);
assert(results.chip.bytes < results.catalogue.bytes);
assert(results.profile.bytes < results.business.bytes);
assert(results.soundFontParser.bytes < results.soundFontInstruments.bytes);
assert(results.mwgTargeted.bytes < results.mwgCatalogue.bytes);
await writeFile(
	resolve(root, 'docs/bundle-results.json'),
	JSON.stringify({ bundler: 'esbuild', results }, null, 2) + '\n',
);
console.table(
	Object.fromEntries(
		Object.entries(results).map(([name, result]) => [
			name,
			{ bytes: result.bytes, gzipBytes: result.gzipBytes, modules: result.modules.length },
		]),
	),
);

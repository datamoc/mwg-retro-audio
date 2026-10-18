import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { embeddedWorkers } from './worker-plugin.mjs';

// Page autonome : le JS de l'exemple piano est inliné dans index.html, ce qui permet de l'ouvrir
// directement (file://) sans serveur local, un script module externe y étant bloqué par le navigateur.
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'examples', 'piano');
const output = resolve(directory, 'synth-demo.html');

const { outputFiles } = await build({
	entryPoints: [resolve(directory, 'main.ts')],
	bundle: true,
	loader: { '.mid': 'binary' },
	minify: true,
	format: 'iife',
	write: false,
	plugins: [embeddedWorkers()],
	logLevel: 'warning',
});
const script = outputFiles[0].text.replaceAll('</script', '<\/script');
const page = (await readFile(resolve(directory, 'index.html'), 'utf8')).replace(
	'<script type="module" src="./app.js"></script>',
	() => `<script>${script}</script>`,
);
if (page.includes('src="./app.js"')) throw new Error('Balise script de index.html introuvable');
await writeFile(output, page);
console.log(`${output} (${Math.round(page.length / 1024)} Ko)`);

import { context } from 'esbuild';
import { resolve } from 'node:path';
import { embeddedWorkers } from './worker-plugin.mjs';

const name = process.argv[2] ?? 'tonejs';
if (!['tonejs', 'piano'].includes(name)) throw new Error('Unknown example');
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'examples', name);
const build = await context({
	entryPoints: [resolve(directory, 'main.ts')],
	outfile: resolve(directory, 'app.js'),
	bundle: true,
	loader: { '.mid': 'binary' },
	format: 'esm',
	sourcemap: true,
	plugins: name === 'piano' ? [embeddedWorkers()] : [],
	logLevel: 'info',
});
await build.watch();
const server = await build.serve({ servedir: directory, host: '127.0.0.1', port: 4173 });
console.log(`Example: http://127.0.0.1:${server.port}`);
async function close() {
	await build.dispose();
	process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);

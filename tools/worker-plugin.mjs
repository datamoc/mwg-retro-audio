import { build } from 'esbuild';
import { resolve } from 'node:path';

/**
 * Plugin esbuild pour les pages d'exemple : `import x from './y.worker.embedded'` fournit le
 * bundle iife (minifié) de `./y.worker.ts` sous forme de texte. La page crée alors son worker
 * avec `new Worker(URL.createObjectURL(new Blob([x])))` : un seul fichier, qui fonctionne aussi
 * en `file://` sur la page autonome synth-demo.html, sans worker externe à servir.
 */
export function embeddedWorkers() {
	return {
		name: 'embedded-workers',
		setup(api) {
			api.onResolve({ filter: /\.worker\.embedded$/ }, (args) => ({
				path: resolve(args.resolveDir, args.path.replace(/\.embedded$/, '.ts')),
				namespace: 'embedded-worker-source',
			}));
			api.onLoad({ filter: /.*/, namespace: 'embedded-worker-source' }, async (args) => {
				const result = await build({
					entryPoints: [args.path],
					bundle: true,
					format: 'iife',
					target: 'es2022',
					minify: true,
					write: false,
					logLevel: 'warning',
					loader: { '.mid': 'binary' },
				});
				return { contents: result.outputFiles[0].text, loader: 'text' };
			});
		},
	};
}

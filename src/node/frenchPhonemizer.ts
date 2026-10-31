import { spawn } from 'node:child_process';

const SCRIPT = `
import json, sys
import espeakng_loader
from phonemizer.backend import EspeakBackend
from phonemizer.backend.espeak.wrapper import EspeakWrapper
EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
text = json.loads(sys.stdin.read()).replace('«', '\u201c').replace('»', '\u201d')
text = text.replace('(', '«').replace(')', '»')
backend = EspeakBackend(language='fr-fr', preserve_punctuation=True,
    with_stress=True, tie='^', language_switch='remove-flags')
print(json.dumps(backend.phonemize([text])[0].strip()))
`;

/**
 * French pronunciation in a separate Python/eSpeak process. Install phonemizer + espeakng-loader into that Python.
 * eSpeak's GPL code stays in the external process; no GPL runtime is linked into the TypeScript library.
 */
export function createFrenchPhonemizer(options: { python?: string } = {}): (text: string) => Promise<string> {
	const python = options.python ?? (process.platform === 'win32' ? 'python' : 'python3');
	return (text) =>
		new Promise((resolve, reject) => {
			const child = spawn(python, ['-c', SCRIPT], { windowsHide: true, timeout: 30000 });
			const output: Buffer[] = [];
			const errors: Buffer[] = [];
			child.stdout.on('data', (data: Buffer) => output.push(data));
			child.stderr.on('data', (data: Buffer) => errors.push(data));
			child.on('error', reject);
			child.stdin.on('error', reject);
			child.on('close', (code) => {
				if (code !== 0) {
					reject(new Error(`French pronunciation failed: ${Buffer.concat(errors).toString('utf8')}`));
					return;
				}
				try {
					const result: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
					if (typeof result !== 'string' || !result.trim())
						throw new Error('No French pronunciation returned');
					resolve(result);
				} catch (error) {
					reject(error);
				}
			});
			// ASCII JSON avoids platform-dependent Python console encodings for accented French text.
			child.stdin.end(
				JSON.stringify(text).replace(
					/[\u007f-\uffff]/gu,
					(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
				),
			);
		});
}

/**
 * Vérification navigateur réel de l'exemple `examples/piano/` : chaque modèle du
 * catalogue construit son panneau, produit un signal non nul (souris, clavier
 * d'ordinateur, MIDI simulé) et relâche ses notes ; les scénarios de secours
 * (refus et absence de Web MIDI, perte de focus, changement de modèle pendant
 * une note, coupure d'urgence, restauration des réglages, pagehide) sont exercés.
 * Les messages MIDI sont simulés par une fausse API Web MIDI : la validation
 * avec un clavier MIDI physique reste consignée séparément (README de l'exemple).
 *
 * Lancement : node tools/piano-check.mjs [modelId]
 * Sortie : examples/piano/check-results.json + journal de synthèse.
 * Nécessite Google Chrome et playwright-core (dépendance du projet voisin ../mwg).
 */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let chromium;
let playwrightVersion = 'from ../mwg';
try {
	({ chromium } = require('playwright-core'));
	playwrightVersion = require('playwright-core/package.json').version;
} catch {
	({ chromium } = require(resolve(import.meta.dirname, '../../mwg/node_modules/playwright-core')));
	playwrightVersion = require(resolve(import.meta.dirname, '../../mwg/node_modules/playwright-core/package.json')).version;
}

const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'examples/piano');
await build({
	entryPoints: [resolve(directory, 'main.ts')],
	outfile: resolve(directory, 'app.js'),
	bundle: true,
	loader: { '.mid': 'binary' },
	format: 'esm',
	sourcemap: true,
	logLevel: 'warning',
});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json' };
const server = createServer(async (request, response) => {
	const path = (request.url ?? '/').split('?')[0];
	if (path === '/favicon.ico') {
		response.statusCode = 204;
		response.end();
		return;
	}
	const file = join(directory, path === '/' ? 'index.html' : path);
	try {
		response.setHeader('content-type', mime[extname(file)] ?? 'application/octet-stream');
		response.end(await readFile(file));
	} catch {
		response.statusCode = 404;
		response.end('not found');
	}
});
// Chrome refuses a few ports (10080 among them): take another one when the system hands out such a port
const BLOCKED_PORTS = new Set([2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6679, 6697, 10080]);
for (;;) {
	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address();
	if (!BLOCKED_PORTS.has(port) && !(port >= 6665 && port <= 6669)) break;
	await new Promise((done) => server.close(done));
}
const url = `http://127.0.0.1:${server.address().port}`;

const instrumentScript = `
	window.__contexts = [];
	const AudioContext = window.AudioContext;
	window.AudioContext = class extends AudioContext {
		constructor(...args) {
			super(...args);
			window.__contexts.push(this);
		}
	};
	const origConnect = AudioNode.prototype.connect;
	let tap = null;
	AudioNode.prototype.connect = function (node, ...rest) {
		const result = origConnect.call(this, node, ...rest);
		try {
			if (node && this.context && node === this.context.destination) {
				tap ??= this.context.createAnalyser();
				tap.fftSize = 2048;
				origConnect.call(this, tap);
			}
		} catch {}
		return result;
	};
	window.__pianoLevel = () => {
		if (!tap) return 0;
		const buffer = new Float32Array(tap.fftSize);
		tap.getFloatTimeDomainData(buffer);
		let peak = 0;
		for (const value of buffer) peak = Math.max(peak, Math.abs(value));
		return peak;
	};
	window.__midi = { mode: 'ok' };
	Object.defineProperty(navigator, 'requestMIDIAccess', {
		configurable: true,
		get() {
			if (window.__midi.mode === 'absent') return undefined;
			return async () => {
				if (window.__midi.mode === 'deny') throw new DOMException('Permission denied', 'NotAllowedError');
				const input = { id: 'sim-in', name: 'Simulated MIDI', manufacturer: 'check', onmidimessage: null };
				window.__midi.input = input;
				window.__midi.send = (bytes) => input.onmidimessage?.({ data: bytes });
				const access = { inputs: new Map([[input.id, input]]), outputs: new Map(), onstatechange: null };
				window.__midi.access = access;
				return access;
			};
		},
	});
`;

const errors = [];
const problems = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
function record(scope, message) {
	problems.push(`${scope}: ${message}`);
	console.error(`FAIL ${scope}: ${message}`);
}
async function newPage(midiMode = 'ok', extra = null) {
	const page = await browser.newPage();
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(`console ${message.text()}`);
	});
	page.on('pageerror', (error) => errors.push(`pageerror ${String(error)}`));
	await page.addInitScript(instrumentScript);
	await page.addInitScript(() => {
		if (!sessionStorage.getItem('lang-pinned')) {
			sessionStorage.setItem('lang-pinned', '1');
			localStorage.setItem('mwg-retro-audio-demo-lang', 'fr');
		}
	});
	await page.addInitScript((mode) => {
		window.__midi.mode = mode;
	}, midiMode);
	if (extra) await page.addInitScript(extra.script, extra.arg);
	await page.goto(url);
	return page;
}
async function enableSound(page) {
	await page.click('#audio');
	await page.waitForFunction(() => window.__contexts.at(-1)?.state === 'running');
}
async function levelWhileHeld(page, press, release, holdMs = 900) {
	await press();
	const started = Date.now();
	let peak = 0;
	while (Date.now() - started < holdMs) {
		peak = Math.max(peak, await page.evaluate(() => window.__pianoLevel()));
		await page.waitForTimeout(50);
	}
	await release();
	return peak;
}
const activeCount = (page) => page.locator('.key.active').count();
const keyboard = (page) => ({
	press: () => page.keyboard.down('KeyA'),
	release: () => page.keyboard.up('KeyA'),
});

const page = await newPage();
await enableSound(page);
const models = await page.evaluate(() =>
	Array.from(document.getElementById('model').options).map((option) => ({ id: option.value, name: option.text })),
);
const only = process.argv[2];
const results = [];
for (const model of models.filter((entry) => !only || entry.id === only)) {
	await page.selectOption('#model', model.id);
	const info = await page.evaluate(() => ({
		controls: document.querySelectorAll('#controls .control').length,
		meta: document.getElementById('info').textContent,
	}));
	const { press, release } = keyboard(page);
	const peak = await levelWhileHeld(page, press, release);
	if (peak < 0.001) record(model.id, `no audible signal (peak ${peak})`);
	if (info.controls < 1) record(model.id, 'empty control panel');
	if (!/voix/.test(info.meta)) record(model.id, 'missing polyphony in info line');
	await page.waitForTimeout(80);
	if ((await activeCount(page)) !== 0) record(model.id, 'note stayed highlighted after keyup');
	results.push({ ...model, peak: Number(peak.toFixed(4)), controls: info.controls });
	console.log(`ok ${model.id}: peak ${peak.toFixed(4)}, ${info.controls} contrôles`);
}

// point 4 : souris (appui/relâchement), accords selon la polyphonie
await page.selectOption('#model', 'ym2149');
const key = page.locator('[data-note="60"]');
await key.scrollIntoViewIfNeeded();
const box = await key.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
const peakMouse = await levelWhileHeld(page, () => page.mouse.down(), () => page.mouse.up());
if (peakMouse < 0.001) record('mouse', `no signal from pointer press (peak ${peakMouse})`);
if ((await activeCount(page)) !== 0) record('mouse', 'pointer note stayed highlighted');
const chord = page.locator('[data-note="64"]');
await chord.scrollIntoViewIfNeeded();
const boxChord = await chord.boundingBox();
await page.keyboard.down('KeyA');
await page.mouse.move(boxChord.x + boxChord.width / 2, boxChord.y + boxChord.height / 2);
await page.mouse.down();
const held = await activeCount(page);
if (held < 2) record('chords', `keyboard and pointer did not hold two notes (${held})`);
await page.mouse.up();
await page.keyboard.up('KeyA');
// changement de modèle pendant une note tenue
await page.keyboard.down('KeyA');
await page.selectOption('#model', 'dx7');
await page.keyboard.up('KeyA');
if ((await activeCount(page)) !== 0) record('model-switch', 'keys stayed highlighted after switching models');
// coupure d'urgence et perte de focus
await page.keyboard.down('KeyA');
await page.click('#panic');
await page.keyboard.up('KeyA');
if ((await activeCount(page)) !== 0) record('panic', 'panic button left active keys');
await page.keyboard.down('KeyS');
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await page.keyboard.up('KeyS');
if ((await activeCount(page)) !== 0) record('blur', 'losing focus left active keys');
// restauration des réglages par défaut (YM2149 : première plage, période de bruit)
await page.selectOption('#model', 'ym2149');
const slider = page.locator('#controls .control input[type="range"]').first();
await slider.evaluate((input) => {
	input.value = input.max;
	input.dispatchEvent(new Event('input'));
});
await page.click('#reset');
const restored = await page.evaluate(() => {
	const control = Array.from(document.querySelectorAll('#controls .control')).find((c) =>
		c.querySelector('input[type=range]'),
	);
	const input = control?.querySelector('input[type=range]');
	const shown = control?.querySelector('output')?.textContent ?? '';
	const match = shown.match(/défaut (\d+(?:\.\d+)?)/);
	return input && match ? { value: Number(input.value), defaultValue: Number(match[1]) } : null;
});
if (!restored || restored.value !== restored.defaultValue)
	record('reset', `settings not restored to defaults (${JSON.stringify(restored)})`);

// enregistrement sans clavier MIDI : clavier d'ordinateur, changement de modèle pendant la prise, aucune note bloquée
const typed = await newPage();
await enableSound(typed);
if (await typed.locator('#recorder').isHidden()) record('recorder', 'panel hidden without a MIDI input');
await typed.click('#recStart');
await typed.keyboard.down('KeyA');
await typed.waitForTimeout(200);
await typed.selectOption('#model', 'sid');
await typed.waitForTimeout(100);
await typed.keyboard.up('KeyA');
await typed.keyboard.press('KeyS');
await typed.waitForTimeout(100);
await typed.click('#recStop');
const typedStatus = await typed.evaluate(() => document.getElementById('recStatus').textContent);
if (!/2 notes/.test(typedStatus)) record('recorder', `typed take: ${typedStatus}`);
const [typedFile] = await Promise.all([typed.waitForEvent('download'), typed.click('#recDownload')]);
const typedBytes = await readFile(await typedFile.path());
const count = (status, note) => typedBytes.filter((byte, i) => byte === status && typedBytes[i + 1] === note).length;
if (count(0x90, 60) !== 1 || count(0x80, 60) < 1) record('recorder', 'note cut by the model change left hanging in the take');
await typed.selectOption('#model', 'ym2149');
await typed.click('#recPlay');
await typed.waitForTimeout(200);
if (!(await typed.evaluate(() => document.getElementById('clock').textContent)).includes('Yamaha YM2149'))
	record('recorder', 'the take did not replay on the model chosen afterwards');
// voix standard et export audio hors ligne : FLAC, Opus (si le navigateur sait l'encoder), WAV
await typed.selectOption('#recVoice', 'standard');
await typed.click('#recPlay');
await typed.waitForTimeout(200);
if (!(await typed.evaluate(() => document.getElementById('clock').textContent)).includes('Piano'))
	record('recorder', 'the take did not replay on the standard voice');
await typed.click('#stop');
for (const [format, magic, extension] of [
	['flac', 'fLaC', '.flac'],
	['wav', 'RIFF', '.wav'],
]) {
	await typed.selectOption('#recFormat', format);
	const [audio] = await Promise.all([typed.waitForEvent('download'), typed.click('#recExport')]);
	const head = (await readFile(await audio.path())).subarray(0, 4).toString('latin1');
	if (head !== magic || !audio.suggestedFilename().endsWith(extension))
		record('recorder', `${format} export: ${head} ${audio.suggestedFilename()}`);
}
const opusUsable = await typed.evaluate(() => typeof AudioEncoder !== 'undefined');
const opusEnabled = await typed.evaluate(() => !document.querySelector('#recFormat option[value="opus"]').disabled);
if (opusUsable !== opusEnabled) record('recorder', `Opus option enabled=${opusEnabled} but WebCodecs=${opusUsable}`);
if (opusEnabled) {
	await typed.selectOption('#recFormat', 'opus');
	const [opus] = await Promise.all([typed.waitForEvent('download', { timeout: 60000 }), typed.click('#recExport')]);
	const head = (await readFile(await opus.path())).subarray(0, 4).toString('latin1');
	if (head !== 'OggS' || !opus.suggestedFilename().endsWith('.opus')) record('recorder', `opus export: ${head}`);
}
await typed.close();

// dossier de MIDI : sélecteur de dossier simulé (liste triée, titre de l'en-tête, sous-dossier, fichiers refusés)
const folderMock = {
	script: (mode) => {
		const smf = (title) => {
			const name = [...title].map((c) => c.charCodeAt(0));
			const track = [0, 0xff, 3, name.length, ...name, 0, 0x90, 60, 100, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0];
			return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length, ...track]);
		};
		const file = (name, data) => ({ kind: 'file', name, getFile: async () => new File([data], name) });
		const dir = (name, children) => ({
			kind: 'directory',
			name,
			entries: async function* () {
				for (const child of children) yield [child.name, child];
			},
		});
		if (mode === 'absent') {
			window.showDirectoryPicker = undefined;
			return;
		}
		window.showDirectoryPicker = async () => {
			if (mode === 'abort') throw new DOMException('closed', 'AbortError');
			if (mode === 'deny') throw new DOMException('refused', 'NotAllowedError');
			return dir('Mes MIDI', [
				file('zeta.mid', smf('Zeta tune')),
				file('alpha.mid', smf('Track 1')),
				file('broken.mid', new Uint8Array([1, 2, 3])),
				file('notes.txt', new Uint8Array([65])),
				dir('sous', [file('deep.mid', smf('Deep tune'))]),
			]);
		};
	},
	arg: 'ok',
};
const folderPage = await newPage('ok', folderMock);
await enableSound(folderPage);
await folderPage.click('#folder');
await folderPage.waitForFunction(() => document.querySelectorAll('#song option').length > 8);
const listedSongs = await folderPage.evaluate(() => Array.from(document.querySelectorAll('#song option')).map((o) => o.textContent));
if (listedSongs.slice(0, 3).join('|') !== 'alpha|Deep tune|Zeta tune') record('folder', `list: ${listedSongs.slice(0, 4)}`);
if (listedSongs.some((title) => /broken|notes/.test(title))) record('folder', 'an unreadable or foreign file was listed');
const folderStatus = await folderPage.evaluate(() => document.getElementById('status').value);
if (!/3 morceaux/.test(folderStatus) || !/1 fichiers ignorés/.test(folderStatus)) record('folder', `status: ${folderStatus}`);
await folderPage.selectOption('#song', { label: 'Zeta tune' });
await folderPage.waitForTimeout(200);
if (!(await folderPage.evaluate(() => document.getElementById('clock').textContent)).includes('Zeta tune'))
	record('folder', 'a song of the folder did not play');
await folderPage.close();
for (const [mode, check] of [
	['abort', (text, disabled) => !/inaccessible/.test(text) && !disabled],
	['deny', (text, disabled) => /Dossier inaccessible/.test(text) && !disabled],
	['absent', (_text, disabled) => disabled],
]) {
	const fallback = await newPage('ok', { script: folderMock.script, arg: mode });
	await enableSound(fallback);
	if (mode !== 'absent') await fallback.click('#folder');
	await fallback.waitForTimeout(150);
	const text = await fallback.evaluate(() => document.getElementById('status').value);
	const disabled = await fallback.evaluate(() => document.getElementById('folder').disabled);
	if (!check(text, disabled)) record(`folder-${mode}`, `status "${text}", disabled ${disabled}`);
	const { press, release } = keyboard(fallback);
	if ((await levelWhileHeld(fallback, press, release, 500)) < 0.001) record(`folder-${mode}`, 'keyboard became unplayable');
	await fallback.close();
}

// le silence du début d'un morceau est ignoré : Méditation compte 3,7 s avant sa première note (4:30 -> 4:26)
const lead = await newPage();
await enableSound(lead);
await lead.selectOption('#song', { label: 'Massenet — Méditation de Thaïs' });
await lead.waitForTimeout(300);
const leadClock = await lead.evaluate(() => document.getElementById('clock').textContent);
if (!/ \/ 4:26 /.test(leadClock)) record('lead-silence', `clock: ${leadClock}`);
await lead.close();

// banques SoundFont : fichier .sf2 ouvert, SF3 refusé, dossier de banques simulé ; aucune banque n'est livrée,
// les fichiers sont fabriqués par tests/sf2file.ts
const sf2Module = await build({
	entryPoints: [resolve(root, 'tests/sf2file.ts')],
	bundle: true,
	format: 'esm',
	write: false,
	logLevel: 'warning',
});
const sf2Tools = await import(`data:text/javascript;base64,${Buffer.from(sf2Module.outputFiles[0].text).toString('base64')}`);
const sampleBank = (name, version) =>
	sf2Tools.buildSf2({
		name,
		version,
		samples: [{ name: 'Sine', data: sf2Tools.sine(100, 8), rate: 44100, rootKey: 69, loopStart: 200, loopEnd: 600 }],
		instruments: [{ name: 'I', zones: [{ gens: [[sf2Tools.GEN.sampleModes, 1]], target: 0 }] }],
		presets: [
			{ name: 'Sine pad', zones: [{ target: 0 }] },
			{ name: 'Sine high', zones: [{ gens: [[sf2Tools.GEN.coarseTune, 12]], target: 0 }] },
		],
	});
const bankPage = await newPage();
await enableSound(bankPage);
await bankPage.setInputFiles('#sfFile', {
	name: 'test-bank.sf2',
	mimeType: 'application/octet-stream',
	buffer: Buffer.from(sampleBank('Test bank', [2, 4])),
});
await bankPage.waitForFunction(() => document.getElementById('model').value.startsWith('soundfont:'));
const bankState = await bankPage.evaluate(() => ({
	group: Array.from(document.querySelectorAll('#model optgroup')).map((g) => g.label).at(-1),
	options: document.querySelectorAll('#model optgroup:last-child option').length,
	status: document.getElementById('status').value,
	controls: document.querySelectorAll('#controls .control').length,
}));
if (bankState.group !== 'SoundFont : Test bank' || bankState.options !== 2 || !/2 préréglages/.test(bankState.status) || bankState.controls < 6)
	record('soundfont', JSON.stringify(bankState));
const bankKeys = keyboard(bankPage);
if ((await levelWhileHeld(bankPage, bankKeys.press, bankKeys.release, 600)) < 0.001) record('soundfont', 'a preset of the bank made no sound');
await bankPage.setInputFiles('#sfFile', {
	name: 'compressed.sf3',
	mimeType: 'application/octet-stream',
	buffer: Buffer.from(sampleBank('Compressed', [3, 0])),
});
await bankPage.waitForFunction(() => /SF3|Vorbis/.test(document.getElementById('status').value));
if ((await levelWhileHeld(bankPage, bankKeys.press, bankKeys.release, 400)) < 0.001) record('soundfont', 'the keyboard stopped after a refused SF3');
await bankPage.close();
const bankFolder = await newPage('ok', {
	script: (bytes) => {
		const file = (name, data) => ({ kind: 'file', name, getFile: async () => new File([new Uint8Array(data)], name) });
		window.showDirectoryPicker = async () => ({
			kind: 'directory',
			name: 'Banques',
			entries: async function* () {
				for (const entry of [file('b-bank.sf2', bytes), file('notes.txt', [65]), file('a-bank.sf2', bytes)]) yield [entry.name, entry];
			},
		});
	},
	arg: [...sampleBank('Folder bank', [2, 4])],
});
await enableSound(bankFolder);
await bankFolder.click('#sfFolder');
await bankFolder.waitForFunction(() => document.querySelectorAll('#sfBank option').length === 3);
const listedBanks = await bankFolder.evaluate(() => Array.from(document.querySelectorAll('#sfBank option')).map((o) => o.textContent));
if (listedBanks.slice(1).join('|') !== 'a-bank.sf2|b-bank.sf2') record('soundfont-folder', `banks: ${listedBanks}`);
await bankFolder.selectOption('#sfBank', '0');
await bankFolder.waitForFunction(() => document.getElementById('model').value.startsWith('soundfont:'));
await bankFolder.close();

// point 4 : MIDI simulé — note-on/off, vélocité, sustain, all-notes-off, déconnexion
const midiPage = await newPage();
await enableSound(midiPage);
await midiPage.click('#midi');
const listed = await midiPage.evaluate(() => document.getElementById('midiInput').options.length);
if (listed < 2) record('midi', 'simulated input was not listed');
await midiPage.selectOption('#midiInput', 'sim-in');
await midiPage.evaluate(() => window.__midi.send(new Uint8Array([0x90, 66, 110])));
await midiPage.waitForTimeout(150);
if ((await midiPage.locator('.key[data-note="66"].active').count()) !== 1)
	record('midi', 'held MIDI note not highlighted');
let peakMidi = await midiPage.evaluate(() => window.__pianoLevel());
for (let tries = 0; tries < 10 && peakMidi < 0.001; tries++) {
	await midiPage.waitForTimeout(60);
	peakMidi = await midiPage.evaluate(() => window.__pianoLevel());
}
if (peakMidi < 0.001) record('midi', 'note-on produced no signal');
await midiPage.evaluate(() => {
	window.__midi.send(new Uint8Array([0xb0, 64, 127]));
	window.__midi.send(new Uint8Array([0x80, 66, 0]));
});
await midiPage.waitForTimeout(120);
if ((await activeCount(midiPage)) !== 0) record('midi', 'note-off under pedal left a highlighted key');
peakMidi = await midiPage.evaluate(() => window.__pianoLevel());
for (let tries = 0; tries < 10 && peakMidi < 0.001; tries++) {
	await midiPage.waitForTimeout(60);
	peakMidi = await midiPage.evaluate(() => window.__pianoLevel());
}
if (peakMidi < 0.001) record('midi', 'sustain pedal did not keep the note sounding after note-off');
await midiPage.evaluate(() => {
	window.__midi.send(new Uint8Array([0xb0, 64, 0]));
	window.__midi.send(new Uint8Array([0xb0, 123, 0]));
});
if ((await activeCount(midiPage)) !== 0) record('midi', 'all-notes-off left active notes');
// enregistrement MIDI : le panneau suit la connexion, la prise est rejouée et exportée en fichier .mid
if (await midiPage.locator('#recorder').isHidden()) record('recorder', 'panel hidden while a MIDI input is selected');
await midiPage.click('#recStart');
await midiPage.evaluate(() => {
	window.__midi.send(new Uint8Array([0x90, 60, 100]));
});
await midiPage.waitForTimeout(250);
await midiPage.evaluate(() => {
	window.__midi.send(new Uint8Array([0x80, 60, 0]));
	window.__midi.send(new Uint8Array([0x90, 64, 80]));
});
await midiPage.waitForTimeout(250);
await midiPage.click('#recStop');
const recStatus = await midiPage.evaluate(() => document.getElementById('recStatus').textContent);
if (!/2 notes/.test(recStatus)) record('recorder', `status after the take: ${recStatus}`);
const [download] = await Promise.all([midiPage.waitForEvent('download'), midiPage.click('#recDownload')]);
const saved = await readFile(await download.path());
if (!download.suggestedFilename().endsWith('.mid') || String.fromCharCode(...saved.subarray(0, 4)) !== 'MThd')
	record('recorder', `downloaded file is not a MIDI file (${download.suggestedFilename()})`);
const hasNote = (note) => saved.some((byte, index) => byte === 0x90 && saved[index + 1] === note);
if (!hasNote(60) || !hasNote(64)) record('recorder', 'the exported file lacks the recorded notes');
await midiPage.click('#recPlay');
let replayLevel = 0;
for (let tries = 0; tries < 20 && replayLevel < 0.001; tries++) {
	await midiPage.waitForTimeout(60);
	replayLevel = await midiPage.evaluate(() => window.__pianoLevel());
}
if (replayLevel < 0.001) record('recorder', 'the replayed take made no sound');
if (!(await midiPage.evaluate(() => document.getElementById('clock').textContent)).includes('Mon enregistrement'))
	record('recorder', 'replay not shown in the transport');
await midiPage.click('#stop');
await midiPage.click('#recClear');
if ((await midiPage.locator('#recPlay').isEnabled()) || !(await midiPage.locator('#recStart').isEnabled()))
	record('recorder', 'buttons wrong after clearing');
// déconnexion réelle de l'entrée : statechange, plus aucune sélection, aucune note bloquée
await midiPage.evaluate(() => {
	window.__midi.send(new Uint8Array([0x90, 70, 100]));
	const access = window.__midi.access;
	access.inputs.delete('sim-in');
	access.onstatechange?.({});
});
await midiPage.waitForTimeout(80);
if ((await midiPage.evaluate(() => document.getElementById('midiInput').value)) !== '')
	record('midi', 'disconnected input still selected');
if ((await activeCount(midiPage)) !== 0) record('midi', 'MIDI disconnect left active notes');
await midiPage.close();
// refus d'accès et absence d'API : les autres modes restent jouables
for (const [mode, expected] of [
	['deny', 'MIDI non connecté'],
	['absent', 'Web MIDI indisponible'],
]) {
	const fallback = await newPage(mode);
	await enableSound(fallback);
	await fallback.click('#midi');
	const text = await fallback.evaluate(() => document.getElementById('status').value);
	if (!text.includes(expected)) record(`midi-${mode}`, `status was "${text}"`);
	const { press, release } = keyboard(fallback);
	const played = await levelWhileHeld(fallback, press, release, 500);
	if (played < 0.001) record(`midi-${mode}`, 'keyboard became unplayable');
	await fallback.close();
}
// langues : français, anglais, allemand ; le modèle choisi est conservé, le choix survit au rechargement
const lang = await newPage();
await lang.selectOption('#model', 'sid');
for (const [code, voices, title] of [
	['en', 'voices', 'The mwg-retro-audio keyboard'],
	['de', 'Stimmen', 'Die Tastatur von mwg-retro-audio'],
	['fr', 'voix', 'Le clavier de mwg-retro-audio'],
]) {
	await lang.selectOption('#lang', code);
	const seen = await lang.evaluate(() => ({
		html: document.documentElement.lang,
		title: document.title,
		h1: document.querySelector('h1').textContent,
		info: document.getElementById('info').textContent,
		model: document.getElementById('model').value,
		untranslated: Array.from(document.querySelectorAll('[data-i18n]')).filter((n) => !n.textContent.trim()).length,
		badge: !!document.querySelector('header .badge svg'),
	}));
	if (seen.html !== code || seen.title !== title || seen.h1 !== title) record(`lang-${code}`, JSON.stringify(seen));
	if (!seen.info.includes(voices)) record(`lang-${code}`, `info line: ${seen.info}`);
	if (seen.model !== 'sid') record(`lang-${code}`, 'model changed with the language');
	if (seen.untranslated || !seen.badge) record(`lang-${code}`, 'empty translated element or missing badge');
}
// dispositions : les étiquettes suivent la disposition, les touches physiques jouent toujours les mêmes notes
for (const [layout, labels, octave] of [
	['azerty', 'Q Z S E D F T G Y H U J K', 'W / X'],
	['qwertz', 'A W S E D F T G Z H U J K', 'Y / X'],
	['qwerty', 'A W S E D F T G Y H U J K', 'Z / X'],
]) {
	await lang.selectOption('#layout', layout);
	const help = await lang.evaluate(() => document.getElementById('keysHelp').textContent);
	if (!help.includes(labels) || !help.includes(octave)) record(`layout-${layout}`, help);
	const first = await lang.evaluate(() => document.querySelector('#keyboard [data-note]').textContent);
	if (first !== labels[0]) record(`layout-${layout}`, `first key labelled ${first}`);
}
await lang.selectOption('#layout', 'azerty');
await lang.selectOption('#lang', 'de');
await lang.reload();
if ((await lang.evaluate(() => document.getElementById('layout').value)) !== 'azerty') record('layout', 'choice lost on reload');
await lang.selectOption('#layout', 'auto');
await lang.selectOption('#lang', 'de');
await lang.reload();
if ((await lang.evaluate(() => document.documentElement.lang)) !== 'de') record('lang', 'choice lost on reload');
await lang.close();
// pagehide libère le contexte audio
const closing = await newPage();
await enableSound(closing);
await closing.evaluate(() => window.dispatchEvent(new Event('pagehide')));
await closing.waitForTimeout(200);
const state = await closing.evaluate(() => window.__contexts.at(-1)?.state ?? 'none');
if (state !== 'closed') record('pagehide', `audio context not closed on pagehide (${state})`);
await closing.close();
for (const error of errors.splice(0)) record('console', error);
await page.close();
await browser.close();
server.close();

const summary = {
	browser: `chrome headless ${browser.version()} (playwright-core ${playwrightVersion})`,
	date: new Date().toISOString().slice(0, 10),
	models: results.length,
	peaks: results,
	midi: 'simulé (fausse API Web MIDI) ; aucun clavier physique essayé',
	problems,
};
await writeFile(resolve(directory, 'check-results.json'), JSON.stringify(summary, null, '\t') + '\n');
assert.equal(problems.length, 0, `${problems.length} piano problems:\n${problems.join('\n')}`);
console.log(`Piano example verified in Chrome : ${results.length} modèles, 0 problème.`);

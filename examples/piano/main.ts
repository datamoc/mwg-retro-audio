import { instrumentCatalogue } from '../../src/instruments/catalogue.ts';
import type { Instrument } from '../../src/instruments/Instrument.ts';
import { RetroStream } from '../../src/driver/RetroStream.ts';
import { InstrumentMidiSink } from '../../src/instruments/InstrumentMidiSink.ts';
import { isXmi, MidiPlayer, parseSmf, trimLeadingSilence, xmiToSmf } from '../../src/formats/midi.ts';
import type { MidiEvent, MidiSong } from '../../src/formats/midi.ts';
import { writeSmf } from '../../src/formats/midiWrite.ts';
import { parseSf2 } from '../../src/formats/soundfont.ts';
import { soundFontBankId, soundFontInstruments } from '../../src/instruments/soundfont.ts';
import type { InstrumentDef } from '../../src/instruments/Instrument.ts';
import { renderPlayerAsync } from '../../src/driver/Renderer.ts';
import { AUDIO_FORMATS, exportAudioBlob } from '../../src/driver/export.ts';
import type { AudioFormat } from '../../src/driver/export.ts';
import { isOpusEncodingAvailable } from '../../src/driver/opus.ts';
import type { RetroPlayer } from '../../src/players/Player.ts';
import { Region } from '../../src/region.ts';
import { describeMachines, featured, groupOrder, machines, names } from './machines.ts';
import exportWorkerSource from './export.worker.embedded';
import type { ExportReply, ExportVoice } from './export.worker.ts';
import { currentLang, initialLang, languages, setLang, t, translatePage } from './i18n.ts';
import type { Key, Lang } from './i18n.ts';
import { songs } from './songs.ts';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const model = element<HTMLSelectElement>('model');
const volume = element<HTMLInputElement>('volume');
const octave = element<HTMLInputElement>('octave');
const status = element<HTMLOutputElement>('status');
const keyboard = element<HTMLDivElement>('keyboard');
const held = new Map<string, number>();
/** the SoundFont banks the user opened: their presets are models too, added to the list of the page */
/** la banque est gardée avec sa source : l'export la relit dans le worker à partir du fichier d'origine */
const loadedBanks: { id: string; name: string; definitions: InstrumentDef[]; source: BankSource }[] = [];
const definitionOf = (id: string): InstrumentDef | undefined =>
	instrumentCatalogue.find((definition) => definition.info.id === id) ??
	loadedBanks.flatMap((bank) => bank.definitions).find((definition) => definition.info.id === id);
/** the take being recorded (times in seconds from the start of the recording) and the last finished one */
let recording: { startedAt: number; events: MidiEvent[] } | undefined;
let take: MidiEvent[] = [];
let said: { key: Key; values: Record<string, string | number> } = { key: 'idle', values: {} };
/** show a message in the status line, in the current language */
function say(key: Key, values: Record<string, string | number> = {}): void {
	said = { key, values };
	status.value = t(key, values);
}
let instrument: Instrument;
let context: AudioContext | undefined;
let gain: GainNode | undefined;
let stream: RetroStream | undefined;
let current: { song: MidiSong; title: string; key: string; voice: Instrument } | undefined;
let startedAt = 0;
const lifetime = new AbortController();
const options = { signal: lifetime.signal };
const shortcuts = [
	'KeyA',
	'KeyW',
	'KeyS',
	'KeyE',
	'KeyD',
	'KeyF',
	'KeyT',
	'KeyG',
	'KeyY',
	'KeyH',
	'KeyU',
	'KeyJ',
	'KeyK',
];

/** what each physical key prints on the layouts that differ from QWERTY (the keys play by position, `event.code`) */
const layoutKeys: Record<string, Record<string, string>> = {
	qwerty: {},
	azerty: { KeyA: 'Q', KeyW: 'Z', KeyZ: 'W' },
	qwertz: { KeyY: 'Z', KeyZ: 'Y' },
};
const layoutSelect = element<HTMLSelectElement>('layout');
const layoutStorage = 'mwg-retro-audio-demo-layout';
let layoutMap: { get(code: string): string | undefined } | undefined;
/** the layout to assume when the browser cannot tell: from the language of the browser */
function guessedLayout(): string {
	const language = (navigator.languages?.[0] ?? navigator.language ?? 'en').toLowerCase();
	if (language.startsWith('fr')) return 'azerty';
	return ['de', 'cs', 'sk', 'hu', 'sl', 'hr'].includes(language.slice(0, 2)) ? 'qwertz' : 'qwerty';
}
/** the letter printed on the physical key `code` ('KeyA' is the key left of S on every layout) */
function keyLabel(code: string): string {
	if (layoutSelect.value === 'auto' && layoutMap) return (layoutMap.get(code) ?? code.slice(3)).toUpperCase();
	const layout = layoutSelect.value === 'auto' ? guessedLayout() : layoutSelect.value;
	return layoutKeys[layout]?.[code] ?? code.slice(3);
}
function paintKeysHelp(): void {
	element('keysHelp').textContent = t('keysHelp', {
		keys: shortcuts.map(keyLabel).join(' '),
		octaveKeys: `${keyLabel('KeyZ')} / ${keyLabel('KeyX')}`,
	});
}
function paintLayout(): void {
	paintKeysHelp();
	drawKeyboard();
}

function paintNotes(): void {
	for (const key of keyboard.querySelectorAll<HTMLButtonElement>('[data-note]')) {
		const active = [...held.values()].includes(Number(key.dataset.note));
		key.classList.toggle('active', active);
		key.setAttribute('aria-pressed', String(active));
	}
}
function press(source: string, note: number, velocity = 100): void {
	if (!context || context.state !== 'running' || held.has(source)) return;
	if (![...held.values()].includes(note)) recordMessage(0x90, note, velocity);
	held.set(source, note);
	instrument.noteOn(note, velocity);
	paintNotes();
}
function release(source: string): void {
	const note = held.get(source);
	if (note === undefined) return;
	held.delete(source);
	if (![...held.values()].includes(note)) {
		instrument.noteOff(note);
		recordMessage(0x80, note, 0);
	}
	paintNotes();
}
function panic(): void {
	// a take must not keep notes that the panic (or a model change) cut: release them in the take too
	for (const note of new Set(held.values())) recordMessage(0x80, note, 0);
	held.clear();
	instrument?.allNotesOff();
	paintNotes();
}
function drawKeyboard(): void {
	keyboard.replaceChildren();
	const start = (Number(octave.value) + 1) * 12;
	const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
	let white = 0;
	for (let offset = 0; offset <= 24; offset++) {
		const note = start + offset;
		const black = [1, 3, 6, 8, 10].includes(note % 12);
		const button = document.createElement('button');
		button.type = 'button';
		button.className = black ? 'key black' : 'key';
		button.dataset.note = String(note);
		button.setAttribute('aria-label', `${names[note % 12]}${Math.floor(note / 12) - 1}`);
		button.setAttribute('aria-pressed', 'false');
		const label = document.createElement('span');
		label.textContent = offset < shortcuts.length ? keyLabel(shortcuts[offset]) : names[note % 12];
		button.append(label);
		if (black) button.style.left = `${(white / 15) * 100}%`;
		else white++;
		button.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			button.setPointerCapture(event.pointerId);
			press(`pointer:${event.pointerId}`, note);
		});
		for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
			button.addEventListener(event, (event) => release(`pointer:${(event as PointerEvent).pointerId}`));
		keyboard.append(button);
	}
}
function controls(): void {
	const panel = element<HTMLDivElement>('controls');
	panel.replaceChildren();
	for (const control of instrument.controls) {
		const label = document.createElement('label');
		label.className = 'control';
		label.title = control.hint ?? '';
		const caption = document.createElement('span');
		caption.textContent = `${control.group ? control.group + ' / ' : ''}${control.label}`;
		label.append(caption);
		if (control.kind === 'choice') {
			const select = document.createElement('select');
			for (const option of control.options) select.add(new Option(option.label, String(option.value)));
			select.value = String(control.get());
			select.onchange = () => control.set(Number(select.value));
			label.append(select);
		} else {
			const input = document.createElement('input');
			input.setAttribute('aria-label', control.label);
			if (control.kind === 'toggle') {
				input.type = 'checkbox';
				input.checked = control.get();
				input.onchange = () => control.set(input.checked);
			} else {
				input.type = 'range';
				input.min = String(control.min);
				input.max = String(control.max);
				input.step = String(control.step);
				input.value = String(control.get());
				const value = document.createElement('output');
				const update = (): void => {
					value.value = t('value', {
						value: control.get(),
						unit: control.unit ?? '',
						def: control.defaultValue,
						min: control.min,
						max: control.max,
					});
				};
				input.oninput = () => {
					control.set(Number(input.value));
					update();
				};
				update();
				label.append(value);
			}
			label.append(input);
		}
		panel.append(label);
	}
}
/** the keyboard: renders the instrument, which the keys play */
function livePlayer(): RetroPlayer {
	return {
		info: { format: 'instrument', chips: [instrument.chip.id], region: Region.PAL, frameRate: 50 },
		sampleRate: context!.sampleRate,
		chips: [instrument.chip],
		finished: false,
		reset: () => instrument.reset(),
		setMuted: (_chip, channel, muted) => instrument.chip.setMuted(channel, muted),
		render: (left, right, start, count) => {
			instrument.render(left, right, start, count);
			return count;
		},
	};
}
function songPlayer(song: MidiSong, voice: Instrument): RetroPlayer {
	return new MidiPlayer(song, { sampleRate: context!.sampleRate }, new InstrumentMidiSink(voice));
}
/** (re)start the audio stream: the current song when there is one, the keyboard alone otherwise */
function attach(): void {
	stream?.stop();
	stream = undefined;
	if (!context || !gain) return;
	if (current) current.voice = voiceFor(current.key);
	const created = new RetroStream(context, gain, current ? songPlayer(current.song, current.voice) : livePlayer(), {
		chunkSeconds: 0.01,
		lookaheadSeconds: 0.04,
	});
	stream = created;
	if (current) {
		created.onended = () => {
			if (stream === created) nextSong();
		};
		startedAt = context.currentTime + 0.05;
	}
	created.start();
}
function presets(): void {
	const bar = element<HTMLDivElement>('presets');
	bar.replaceChildren();
	instrument.presets.forEach((preset, index) => {
		const button = document.createElement('button');
		button.type = 'button';
		button.textContent = preset.name;
		button.addEventListener('click', () => {
			panic();
			instrument.applyPreset(index);
			controls();
			say('presetApplied', { name: preset.name });
		});
		bar.append(button);
	});
	bar.hidden = instrument.presets.length === 0;
}
function paintMachines(): void {
	for (const button of element('machines').querySelectorAll<HTMLButtonElement>('button'))
		button.setAttribute('aria-pressed', String(button.dataset.model === model.value));
}
/** the lines under the model list, which depend on the language */
function describe(): void {
	element('info').textContent = t('info', {
		name: instrument.info.name,
		voices: instrument.info.polyphony,
		era: instrument.info.era,
	});
	element('where').textContent = describeMachines(instrument.info.id);
}
function choose(): void {
	panic();
	instrument = definitionOf(model.value)!.create({ sampleRate: context?.sampleRate ?? 44100 });
	instrument.onChange = controls;
	element('description').textContent = instrument.info.description;
	describe();
	controls();
	presets();
	paintMachines();
	paintRandomModels();
	attach();
}
function buildModelList(): void {
	const selected = model.value || 'ym2149';
	model.replaceChildren();
	for (const group of groupOrder) {
		const section = document.createElement('optgroup');
		section.label = t(group);
		for (const definition of instrumentCatalogue) {
			const entry = machines[definition.info.id];
			if ((entry?.group ?? 'simple') !== group) continue;
			const where = [...names(entry?.computers), ...names(entry?.consoles)].slice(0, 3).join(', ');
			section.append(
				new Option(where ? `${definition.info.name} — ${where}` : definition.info.name, definition.info.id),
			);
		}
		if (section.children.length) model.append(section);
	}
	for (const bank of loadedBanks) {
		const section = document.createElement('optgroup');
		section.label = t('sfGroup', { name: bank.name });
		for (const definition of bank.definitions) section.append(new Option(definition.info.name, definition.info.id));
		model.append(section);
	}
	model.value = definitionOf(selected) ? selected : 'ym2149';
}
buildModelList();
model.value = 'ym2149';
for (const { label, model: id } of featured) {
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = label;
	button.dataset.model = id;
	button.className = id === 'ym2149' ? 'star' : '';
	button.title = instrumentCatalogue.find((definition) => definition.info.id === id)?.info.name ?? id;
	button.addEventListener('click', () => {
		model.value = id;
		choose();
	});
	element('machines').append(button);
}
model.addEventListener('change', choose, options);
/** the browser starts audio only after a user gesture: every button that makes sound goes through here */
async function ensureAudio(): Promise<boolean> {
	try {
		context ??= new AudioContext();
		await context.resume();
		if (!gain) {
			gain = context.createGain();
			gain.gain.value = Number(element<HTMLInputElement>('volume').value);
			gain.connect(context.destination);
			choose();
		}
		say('soundOn');
		return true;
	} catch (error) {
		status.value = String(error);
		return false;
	}
}
element('audio').addEventListener('click', () => void ensureAudio(), options);

/** the page's two modes: simple (a handful of random models and the keyboard), complex (everything) */
const modeStorage = 'mwg-retro-audio-demo-mode';
const panelSimple = element<HTMLElement>('panel-simple');
const panelComplex = element<HTMLElement>('panel-complex');
function setMode(mode: 'simple' | 'complex'): void {
	panelSimple.hidden = mode !== 'simple';
	panelComplex.hidden = mode !== 'complex';
	element('tabSimple').setAttribute('aria-selected', String(mode === 'simple'));
	element('tabComplex').setAttribute('aria-selected', String(mode === 'complex'));
	try {
		localStorage.setItem(modeStorage, mode);
	} catch {
		// storage blocked: the mode simply starts over next time
	}
}
element('tabSimple').addEventListener('click', () => setMode('simple'), options);
element('tabComplex').addEventListener('click', () => setMode('complex'), options);
try {
	const saved = localStorage.getItem(modeStorage);
	setMode(saved === 'complex' ? 'complex' : 'simple');
} catch {
	setMode('simple');
}
/**
 * Eight playable models drawn from the hat out of the catalogue; a click switches model,
 * the current one is highlighted; the dice button draws eight others.
 */
let randomModels: InstrumentDef[] = [];
function drawRandomModels(): void {
	const pool: InstrumentDef[] = [...instrumentCatalogue];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}
	randomModels = pool.slice(0, 8);
	paintRandomModels();
}
function paintRandomModels(): void {
	const bar = element<HTMLDivElement>('randomModels');
	bar.replaceChildren();
	for (const definition of randomModels) {
		const button = document.createElement('button');
		button.type = 'button';
		button.dataset.model = definition.info.id;
		button.textContent = definition.info.name;
		button.title = definition.info.description;
		button.setAttribute('aria-pressed', String(model.value === definition.info.id));
		button.addEventListener('click', () => {
			void ensureAudio();
			model.value = definition.info.id;
			choose();
		});
		bar.append(button);
	}
	const reroll = document.createElement('button');
	reroll.type = 'button';
	reroll.textContent = t('randomReroll');
	reroll.title = t('randomRerollTitle');
	reroll.addEventListener('click', drawRandomModels);
	bar.append(reroll);
}
drawRandomModels();

const songSelect = element<HTMLSelectElement>('song');
const playButton = element<HTMLButtonElement>('play');
const stopButton = element<HTMLButtonElement>('stop');
const clock = element('clock');
const progress = element<HTMLProgressElement>('progress');
const chain = element<HTMLInputElement>('chain');
const format = (seconds: number): string =>
	`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
/** a song as the page plays it: without the silence before the first note */
const readSong = (bytes: Uint8Array): MidiSong => trimLeadingSilence(parseSmf(isXmi(bytes) ? xmiToSmf(bytes) : bytes));

/** a song of the list: the songs of the page, the files and the folder of the user, and the last take */
interface Entry {
	key: string;
	kind: 'built-in' | 'file' | 'folder' | 'take';
	title: () => string;
	song: () => MidiSong;
}
const builtIn: Entry[] = songs.map((song, index) => ({
	key: `built-in:${index}`,
	kind: 'built-in',
	title: () => song.title[currentLang()],
	song: () => readSong(song.bytes),
}));
let userEntries: Entry[] = [];
let takeEntry: Entry | undefined;
const library = (): Entry[] => [...(takeEntry ? [takeEntry] : []), ...userEntries, ...builtIn];
const entryOf = (key: string): Entry | undefined => library().find((entry) => entry.key === key);

function buildSongList(): void {
	const selected = songSelect.value || builtIn[0].key;
	songSelect.replaceChildren();
	for (const entry of library()) songSelect.add(new Option(entry.title(), entry.key));
	songSelect.value = entryOf(selected) ? selected : builtIn[0].key;
}
buildSongList();
/** the instrument a song plays on: the chosen model, or the plain piano when the song voice is the standard one */
function voiceFor(_key: string): Instrument {
	if (element<HTMLSelectElement>('songVoice').value === 'standard')
		return definitionOf('simple:Piano')!.create({ sampleRate: context?.sampleRate ?? 44100 });
	return instrument;
}
function paintSong(): void {
	paintExport();
	playButton.textContent = current ? t('playAgain') : t('play');
	stopButton.disabled = !current;
	if (!current) {
		clock.textContent = '';
		progress.value = 0;
		return;
	}
	const elapsed = Math.max(0, Math.min(current.song.duration, (context?.currentTime ?? 0) - startedAt));
	progress.max = current.song.duration || 1;
	progress.value = elapsed;
	clock.textContent = t('clock', {
		title: current.title,
		elapsed: format(elapsed),
		total: format(current.song.duration),
		name: current.voice.info.name,
	});
}
async function playSong(key: string): Promise<void> {
	const entry = entryOf(key);
	if (!entry || !(await ensureAudio())) return;
	let song: MidiSong;
	try {
		song = entry.song();
	} catch (error) {
		say('fileBad', { error: String(error) });
		return;
	}
	panic();
	current = { song, title: entry.title(), key, voice: instrument };
	songSelect.value = key;
	attach();
	paintSong();
	say('playing', { title: current.title });
}
function stopSong(): void {
	current = undefined;
	attach();
	paintSong();
	say('stopped');
}
/** the next song of the list, the take left out; the list starts over after its last entry */
function nextSong(): void {
	if (!current) return;
	if (!chain.checked) return stopSong();
	const queue = library().filter((entry) => entry.kind !== 'take');
	const at = queue.findIndex((entry) => entry.key === current!.key);
	void playSong(queue[(at + 1) % queue.length].key);
}
playButton.addEventListener('click', () => void playSong(songSelect.value), options);
songSelect.addEventListener('change', () => void playSong(songSelect.value), options);
stopButton.addEventListener('click', stopSong, options);

let userCount = 0;
/** a file or a folder entry; the title is the one in the header of the file, the name of the file without it */
function userEntry(kind: 'file' | 'folder', name: string, song: MidiSong): Entry {
	const header = song.title?.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '').trim();
	const title = header && !/^track\s*\d*$/i.test(header) ? header : name.replace(/\.(mid|midi|xmi)$/i, '');
	return { key: `${kind}:${++userCount}`, kind, title: () => title, song: () => song };
}
element<HTMLInputElement>('file').addEventListener(
	'change',
	async (event) => {
		const input = event.target as HTMLInputElement;
		const added: Entry[] = [];
		for (const file of input.files ?? []) {
			try {
				added.push(userEntry('file', file.name, readSong(new Uint8Array(await file.arrayBuffer()))));
			} catch (error) {
				say('fileBad', { error: `${file.name}: ${String(error)}` });
			}
		}
		input.value = '';
		if (!added.length) return;
		userEntries = [...added, ...userEntries];
		buildSongList();
		await playSong(added[0].key);
	},
	options,
);

// a folder of the computer, with the File System Access API (Chrome and Edge); the file input above is the fallback
interface DirectoryHandle {
	name: string;
	entries(): AsyncIterable<[string, { kind: 'file' | 'directory'; name: string }]>;
}
const MAX_FOLDER_FILES = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FOLDER_DEPTH = 3;
const folderButton = element<HTMLButtonElement>('folder');
const directoryPicker = (
	window as unknown as { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<DirectoryHandle> }
).showDirectoryPicker;
folderButton.disabled = !directoryPicker;
if (!directoryPicker) folderButton.title = t('folderUnavailable');
async function readFolder(folder: DirectoryHandle, depth = 0): Promise<{ entries: Entry[]; skipped: number }> {
	const found: Entry[] = [];
	let skipped = 0;
	const names: { handle: { kind: string; name: string }; name: string }[] = [];
	for await (const [name, handle] of folder.entries()) names.push({ handle, name });
	names.sort((a, b) => a.name.localeCompare(b.name));
	for (const { handle, name } of names) {
		if (found.length >= MAX_FOLDER_FILES) break;
		if (handle.kind === 'directory') {
			if (depth < MAX_FOLDER_DEPTH) {
				const inner = await readFolder(handle as unknown as DirectoryHandle, depth + 1);
				found.push(...inner.entries);
				skipped += inner.skipped;
			}
		} else if (/\.(mid|midi|xmi)$/i.test(name)) {
			try {
				const file = await (handle as unknown as { getFile(): Promise<File> }).getFile();
				if (file.size > MAX_FILE_BYTES) throw new RangeError('file too large');
				found.push(userEntry('folder', name, readSong(new Uint8Array(await file.arrayBuffer()))));
			} catch {
				skipped++;
			}
		}
	}
	return { entries: found, skipped };
}
folderButton.addEventListener(
	'click',
	async () => {
		if (!directoryPicker) return;
		try {
			const folder = await directoryPicker.call(window, { mode: 'read' });
			const { entries, skipped } = await readFolder(folder);
			if (!entries.length) return say('folderEmpty', { name: folder.name });
			userEntries = [...entries, ...userEntries.filter((entry) => entry.kind !== 'folder')];
			buildSongList();
			songSelect.value = entries[0].key;
			paintExport();
			say('folderLoaded', { count: entries.length, name: folder.name });
			if (skipped) status.value += t('folderSkipped', { skipped });
		} catch (error) {
			if ((error as Error).name !== 'AbortError') say('folderFail', { error: String(error) });
		}
	},
	options,
);
const ticker = setInterval(() => {
	if (current) paintSong();
}, 250);

element<HTMLInputElement>('volume').addEventListener(
	'input',
	(event) => {
		const value = Number((event.target as HTMLInputElement).value);
		if (gain) gain.gain.setTargetAtTime(value, context!.currentTime, 0.01);
		// raising the slider by hand cancels the pending reactivation of the emergency button
		if (mutedByPanic && value > 0) {
			mutedByPanic = false;
			paintPanic();
		}
	},
	options,
);
/**
 * The emergency button is a switch: it cuts the notes and silences the page, and the same
 * button then brings the sound back at the volume it had before the cut.
 */
let mutedByPanic = false;
let volumeBeforePanic = volume.value;
function paintPanic(): void {
	element('panic').textContent = t(mutedByPanic ? 'panicAgain' : 'panic');
}
element('panic').addEventListener(
	'click',
	() => {
		if (!mutedByPanic) {
			panic();
			volumeBeforePanic = volume.value;
			volume.value = '0';
			if (gain && context) gain.gain.setTargetAtTime(0, context.currentTime, 0.01);
			mutedByPanic = true;
			say('panicCut');
		} else {
			volume.value = volumeBeforePanic || '0.6';
			if (gain && context) gain.gain.setTargetAtTime(Number(volume.value), context.currentTime, 0.01);
			mutedByPanic = false;
			say('panicOn');
		}
		paintPanic();
	},
	options,
);
element('reset').addEventListener(
	'click',
	() => {
		panic();
		instrument.reset();
		controls();
	},
	options,
);
octave.addEventListener(
	'change',
	() => {
		panic();
		octave.value = String(Math.max(0, Math.min(7, Number(octave.value) || 0)));
		drawKeyboard();
	},
	options,
);
window.addEventListener(
	'keydown',
	(event) => {
		if ((event.target as HTMLElement).matches('input,select,textarea')) return;
		if (event.code === 'KeyZ' || event.code === 'KeyX') {
			if (event.repeat) return;
			octave.value = String(Number(octave.value) + (event.code === 'KeyZ' ? -1 : 1));
			octave.dispatchEvent(new Event('change'));
			return;
		}
		const offset = shortcuts.indexOf(event.code);
		if (offset >= 0) {
			event.preventDefault();
			press(event.code, (Number(octave.value) + 1) * 12 + offset);
		}
	},
	options,
);
window.addEventListener('keyup', (event) => release(event.code), options);
window.addEventListener('blur', panic, options);
// SoundFont banks: the user opens .sf2 files, the presets join the list of models
const SF_MAX_BYTES = 512 * 1024 * 1024;
const sfBank = element<HTMLSelectElement>('sfBank');
interface BankSource {
	name: string;
	file: () => Promise<File>;
}
let bankSources: BankSource[] = [];
function buildBankList(): void {
	sfBank.replaceChildren(new Option(bankSources.length ? '—' : t('sfNone'), ''));
	bankSources.forEach((source, index) => sfBank.add(new Option(source.name, String(index))));
	sfBank.disabled = bankSources.length === 0;
}
async function openBank(source: BankSource): Promise<void> {
	say('sfLoading', { name: source.name });
	try {
		const file = await source.file();
		if (file.size > SF_MAX_BYTES) return say('sfTooBig', { name: source.name, limit: formatSize(SF_MAX_BYTES) });
		const font = parseSf2(new Uint8Array(await file.arrayBuffer()));
		const id = soundFontBankId(source.name);
		const bank = { id, name: font.name || source.name, definitions: soundFontInstruments(font, id), source };
		if (!bank.definitions.length) return say('sfBad', { error: 'no preset' });
		const known = loadedBanks.findIndex((entry) => entry.id === id);
		if (known >= 0) loadedBanks.splice(known, 1);
		loadedBanks.push(bank);
		buildModelList();
		model.value = bank.definitions[0].info.id;
		choose();
		say('sfLoaded', { count: bank.definitions.length, name: bank.name });
	} catch (error) {
		say('sfBad', { error: (error as Error).message });
	}
}
sfBank.addEventListener(
	'change',
	() => {
		const source = bankSources[Number(sfBank.value)];
		if (sfBank.value !== '' && source) void openBank(source);
	},
	options,
);
element<HTMLInputElement>('sfFile').addEventListener(
	'change',
	(event) => {
		const input = event.target as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		bankSources = files.map((file) => ({ name: file.name, file: async () => file }));
		buildBankList();
		if (bankSources.length === 1) void openBank(bankSources[0]);
		else if (bankSources.length) say('sfFound', { count: bankSources.length, name: '…' });
	},
	options,
);
const sfFolderButton = element<HTMLButtonElement>('sfFolder');
sfFolderButton.disabled = !directoryPicker;
if (!directoryPicker) sfFolderButton.title = t('folderUnavailable');
sfFolderButton.addEventListener(
	'click',
	async () => {
		if (!directoryPicker) return;
		try {
			const folder = await directoryPicker.call(window, { mode: 'read' });
			const found: BankSource[] = [];
			const walk = async (directory: DirectoryHandle, depth: number): Promise<void> => {
				const names: { handle: { kind: string; name: string }; name: string }[] = [];
				for await (const [name, handle] of directory.entries()) names.push({ handle, name });
				names.sort((a, b) => a.name.localeCompare(b.name));
				for (const { handle, name } of names) {
					if (found.length >= MAX_FOLDER_FILES) return;
					if (handle.kind === 'directory' && depth < MAX_FOLDER_DEPTH)
						await walk(handle as unknown as DirectoryHandle, depth + 1);
					else if (handle.kind === 'file' && /\.(sf2|sf3)$/i.test(name))
						found.push({ name, file: () => (handle as unknown as { getFile(): Promise<File> }).getFile() });
				}
			};
			await walk(folder, 0);
			bankSources = found;
			buildBankList();
			if (!found.length) say('sfNoneInFolder', { name: folder.name });
			else say('sfFound', { count: found.length, name: folder.name });
		} catch (error) {
			if ((error as Error).name !== 'AbortError') say('folderFail', { error: String(error) });
		}
	},
	options,
);
buildBankList();

const recButtons = {
	start: element<HTMLButtonElement>('recStart'),
	stop: element<HTMLButtonElement>('recStop'),
	play: element<HTMLButtonElement>('recPlay'),
	download: element<HTMLButtonElement>('recDownload'),
	clear: element<HTMLButtonElement>('recClear'),
};
let exporting = false;
const exportFormat = element<HTMLSelectElement>('exportFormat');
// Opus needs WebCodecs: the option is greyed out where the browser cannot encode it
void isOpusEncodingAvailable().then((available) => {
	const option = exportFormat.querySelector<HTMLOptionElement>('option[value="opus"]')!;
	option.disabled = !available;
	option.title = available ? '' : t('recOpusMissing');
	if (!available && exportFormat.value === 'opus') exportFormat.value = 'flac';
});
const formatSize = (bytes: number): string =>
	bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** the thread the last export ran on; the browser check reads it to prove the worker is used */
const retroWindow = window as unknown as { __retroExportThread?: 'worker' | 'inline' };
retroWindow.__retroExportThread = 'inline';
let exportWorker: Worker | undefined;
let exportWorkerFailed = false;
let exportSeq = 0;
const exportWaiters = new Map<
	number,
	{ onProgress: (fraction: number) => void; done: (blob: Blob) => void; fail: (error: Error) => void }
>();
/** the export thread, created once from its embedded source; null when this browser or page cannot have one */
function getExportWorker(): Worker | null {
	if (exportWorkerFailed) return null;
	if (exportWorker) return exportWorker;
	// built without the embed plugin (or no Worker in this browser): fall back to the page thread
	if (!exportWorkerSource || typeof Worker === 'undefined') {
		exportWorkerFailed = true;
		return null;
	}
	try {
		const url = URL.createObjectURL(new Blob([exportWorkerSource], { type: 'text/javascript' }));
		const worker = new Worker(url);
		// no early URL.revokeObjectURL: the thread has not necessarily read the blob yet
		worker.onmessage = (event: MessageEvent<ExportReply>) => {
			const { id, progress, buffer, mime, error } = event.data;
			if (id === undefined || (!buffer && progress === undefined && !error)) return;
			const waiter = exportWaiters.get(id);
			if (!waiter) return;
			if (progress !== undefined && !buffer && !error) return waiter.onProgress(progress);
			exportWaiters.delete(id);
			if (error) return waiter.fail(new Error(error));
			waiter.done(new Blob([buffer!], { type: mime ?? 'application/octet-stream' }));
		};
		worker.onerror = (event) => {
			// a worker that cannot even load: every waiter falls back, and no further export tries it
			exportWorkerFailed = true;
			exportWorker = undefined;
			worker.terminate();
			const why = new Error(`export worker: ${event.message || 'unavailable'}`);
			for (const waiter of exportWaiters.values()) waiter.fail(why);
			exportWaiters.clear();
		};
		exportWorker = worker;
		return worker;
	} catch {
		exportWorkerFailed = true;
		return null;
	}
}
/** the voice to rebuild in the worker: a SoundFont preset carries its bank's bytes, re-read from its file */
async function exportVoice(): Promise<ExportVoice> {
	const key = element<HTMLSelectElement>('songVoice').value === 'standard' ? 'simple:Piano' : instrument.info.id;
	const controls: [string, number | boolean][] =
		key === instrument.info.id ? instrument.controls.map((control) => [control.id, control.get()]) : [];
	const match = /^soundfont:(.+):(\d+)$/.exec(key);
	const bank = match ? loadedBanks.find((entry) => entry.id === match[1]) : undefined;
	if (!bank) return { id: key, controls };
	const file = await bank.source.file();
	return { id: key, controls, bank: { bytes: await file.arrayBuffer(), id: bank.id, preset: Number(match![2]) } };
}
/** render and encode in the worker thread; any answer other than a blob rejects to the caller's fallback */
function exportOnWorker(voice: ExportVoice, song: MidiSong, kind: AudioFormat, rate: number, title: string, onProgress: (fraction: number) => void): Promise<Blob> {
	const worker = getExportWorker();
	if (!worker) return Promise.reject(new Error('no export worker in this page'));
	return new Promise<Blob>((resolve, reject) => {
		const id = ++exportSeq;
		exportWaiters.set(id, { onProgress, done: resolve, fail: reject });
		const name = definitionOf(voice.id)?.info.name ?? voice.id;
		worker.postMessage(
			{ id, voice, events: song.events, duration: song.duration, sampleRate: rate, format: kind, title, comment: `${name} — mwg-retro-audio` },
			voice.bank ? [voice.bank.bytes] : [],
		);
	});
}
/** a copy of the live instrument for an offline render: same model, same settings, and no disturbing the live notes */
function offlineVoice(rate: number): Instrument {
	const key = element<HTMLSelectElement>('songVoice').value === 'standard' ? 'simple:Piano' : instrument.info.id;
	const copy = definitionOf(key)!.create({ sampleRate: rate });
	if (key === instrument.info.id)
		for (const { id, get } of instrument.controls.map((control) => ({ id: control.id, get: () => control.get() })))
			(
				copy.controls.find((control) => control.id === id) as { set(value: number | boolean): void } | undefined
			)?.set(get());
	return copy;
}
const exportButton = element<HTMLButtonElement>('exportButton');
const exportProgress = element<HTMLProgressElement>('exportProgress');
/** the label of the export button names the song it will export, and the button is off while a render runs */
function paintExport(): void {
	const entry = entryOf(songSelect.value);
	exportButton.textContent = t('exportButton', { title: entry?.title() ?? '' });
	exportButton.disabled = !entry || exporting;
}
/** render the song selected in the list offline, through the chosen voice, and download it as FLAC, Opus or WAV */
async function exportSong(): Promise<void> {
	const entry = entryOf(songSelect.value);
	if (!entry || exporting) return;
	const kind = exportFormat.value as AudioFormat;
	exporting = true;
	paintExport();
	exportProgress.hidden = false;
	exportProgress.value = 0;
	say('recExporting', { format: kind.toUpperCase() });
	try {
		const rate = context?.sampleRate ?? 44100;
		const song = entry.song();
		const onProgress = (fraction: number): void => {
			exportProgress.value = fraction;
			say('exportProgress', { title: entry.title(), percent: Math.round(fraction * 100) });
		};
		let blob: Blob | undefined;
		try {
			// another thread renders the file: the music playing on the page keeps running
			blob = await exportOnWorker(await exportVoice(), song, kind, rate, entry.title(), onProgress);
			retroWindow.__retroExportThread = 'worker';
		} catch {
			blob = undefined;
		}
		if (!blob) {
			// no worker (or the worker failed): the same render inside the page, giving time back regularly
			const voice = offlineVoice(rate);
			const player = new MidiPlayer(song, { sampleRate: rate }, new InstrumentMidiSink(voice));
			const rendered = await renderPlayerAsync(player, {
				maxSeconds: song.duration + 2,
				fadeOut: 0.05,
				onProgress,
			});
			blob = await exportAudioBlob(rendered, kind, {
				tags: { TITLE: entry.title(), COMMENT: `${voice.info.name} — mwg-retro-audio` },
			});
			retroWindow.__retroExportThread = 'inline';
		}
		const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
		const base = soundFontBankId(entry.title()) || 'song';
		saveBlob(blob, `${base}-${stamp}.${AUDIO_FORMATS[kind].extension}`);
	} catch (error) {
		say('recExportFail', { error: String(error) });
	} finally {
		exporting = false;
		exportProgress.hidden = true;
		paintExport();
	}
}
/** hand a blob to the browser as a download */
function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
	say('recExported', { name, size: formatSize(blob.size) });
}
/**
 * The share link: the chosen model with its settings and the selected song, JSON-serialised,
 * deflated and base64url-encoded into one URL parameter. A SoundFont bank is refused (its
 * samples are the user's own file and cannot travel); an imported MIDI is embedded, and when
 * the URL grows past the safe length a bisection finds how many notes still fit.
 */
const SHARE_LIMIT = 2000;
const streams = globalThis as unknown as {
	CompressionStream?: new (format: string) => CompressionStream;
	DecompressionStream?: new (format: string) => DecompressionStream;
};
type SongPayload = ['b', number] | ['f', string, MidiEvent[], number];
interface SharePayload {
	m: string;
	c: [string, number | boolean][];
	o?: string;
	v?: string;
	s?: SongPayload;
}
const b64url = (bytes: Uint8Array): string => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const fromB64url = (text: string): Uint8Array => {
	const b64 = text.replaceAll('-', '+').replaceAll('_', '/');
	const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
};
/** 'd' when deflated, 'r' when the browser has no CompressionStream: the payload says which */
async function packShare(state: SharePayload): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(state));
	const compressor = streams.CompressionStream;
	if (!compressor) return 'r' + b64url(bytes);
	const stream = new Blob([bytes]).stream().pipeThrough(new compressor('deflate-raw'));
	return 'd' + b64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}
async function unpackShare(payload: string): Promise<SharePayload> {
	const bytes = fromB64url(payload.slice(1));
	let data = bytes;
	if (payload[0] === 'd') {
		const decompressor = streams.DecompressionStream;
		if (!decompressor) throw new Error('deflate-raw needed but this browser has no DecompressionStream');
		const stream = new Blob([bytes]).stream().pipeThrough(new decompressor('deflate-raw'));
		data = new Uint8Array(await new Response(stream).arrayBuffer());
	}
	return JSON.parse(new TextDecoder().decode(data)) as SharePayload;
}
const shareUrl = async (state: SharePayload): Promise<string> =>
	`${location.href.split('?')[0]}?p=${await packShare(state)}`;
const shareSong = (entry: Entry, events: MidiEvent[], kept: number, truncated: boolean): SongPayload => [
	'f',
	entry.kind === 'take' ? '' : truncated ? `${entry.title()}…` : entry.title(),
	events.slice(0, kept),
	Math.max(events[Math.max(0, kept - 1)].time, 0.2),
];
async function generateShare(): Promise<void> {
	if (instrument.info.id.startsWith('soundfont:')) {
		// the bank's samples are the user's own files: they cannot travel inside a link
		shareLink.value = '';
		shareCopy.disabled = true;
		return say('shareSoundfont');
	}
	const base: Omit<SharePayload, 's'> = {
		m: instrument.info.id,
		c: instrument.controls.map((control) => [control.id, control.get()] as [string, number | boolean]),
	};
	if (octave.value !== '4') base.o = octave.value;
	if (element<HTMLSelectElement>('songVoice').value === 'standard') base.v = 'standard';
	const entry = entryOf(songSelect.value);
	let state: SharePayload = base;
	let notes = 0;
	let truncated = false;
	if (entry?.kind === 'built-in') state = { ...base, s: ['b', Number(entry.key.slice('built-in:'.length))] };
	else if (entry) {
		const song = entry.song();
		const whole = await shareUrl({ ...base, s: shareSong(entry, song.events, song.events.length, false) });
		if (whole.length <= SHARE_LIMIT) state = { ...base, s: shareSong(entry, song.events, song.events.length, false) };
		else {
			// bisection over the kept notes: the longest song whose link still fits
			truncated = true;
			let low = 0;
			let high = song.events.length;
			while (low + 1 < high) {
				const middle = (low + high) >> 1;
				const candidate = await shareUrl({ ...base, s: shareSong(entry, song.events, middle, true) });
				if (candidate.length <= SHARE_LIMIT) low = middle;
				else high = middle;
			}
			notes = low;
			state = low ? { ...base, s: shareSong(entry, song.events, low, true) } : base;
			if (!low) truncated = false; // not even one note fits: settings only
		}
	}
	try {
		const link = await shareUrl(state);
		shareLink.value = link;
		shareCopy.disabled = !link;
		say(truncated ? 'shareTruncated' : 'shareOk', { length: link.length, notes: notes || entry?.song().events.length || 0 });
	} catch (error) {
		say('shareFail', { error: String(error) });
	}
}
/** apply a shared link at startup: the model and its settings, the octave, the song */
async function applySharedLink(): Promise<void> {
	const payload = new URLSearchParams(location.search).get('p');
	if (!payload) return;
	try {
		const state = await unpackShare(payload);
		if (state.m && !state.m.startsWith('soundfont:') && definitionOf(state.m)) {
			model.value = state.m;
			choose();
			if (state.m === instrument.info.id)
				for (const [id, value] of state.c)
					(instrument.controls.find((control) => control.id === id) as
						| { set(value: number | boolean): void }
						| undefined)?.set(value);
		}
		if (state.o) {
			octave.value = String(Math.max(0, Math.min(7, Number(state.o) || 0)));
			drawKeyboard();
		}
		if (state.v === 'standard') element<HTMLSelectElement>('songVoice').value = 'standard';
		let loaded = '';
		if (state.s?.[0] === 'b') {
			const key = `built-in:${state.s[1]}`;
			if (entryOf(key)) {
				songSelect.value = key;
				loaded = entryOf(key)!.title();
			}
		} else if (state.s) {
			const [, name, events, duration] = state.s;
			const received: Entry = {
				key: `file:${++userCount}`,
				kind: 'file',
				title: () => name || t('sharedSong'),
				song: () => ({ events, duration }),
			};
			userEntries = [received, ...userEntries];
			buildSongList();
			songSelect.value = received.key;
			loaded = received.title();
		}
		controls();
		paintExport();
		say('shareLoaded', { name: loaded || t('noSharedSong'), model: instrument.info.name });
	} catch (error) {
		say('shareFail', { error: String(error) });
	}
}
const shareLink = element<HTMLInputElement>('shareLink');
const shareCopy = element<HTMLButtonElement>('shareCopy');
element('shareButton').addEventListener('click', () => void generateShare(), options);
shareCopy.addEventListener(
	'click',
	() => {
		navigator.clipboard
			?.writeText(shareLink.value)
			.then(() => say('shareCopied'))
			.catch(() => {
				shareLink.select();
				say('shareNoClipboard');
			});
	},
	options,
);
const noteCount = (events: readonly MidiEvent[]): number =>
	events.filter((event) => event.status === 0x90 && event.data2 > 0).length;
/** keep a message played now while a take is being recorded */
function recordMessage(status: number, data1: number, data2: number): void {
	if (!recording) return;
	recording.events.push({ time: (performance.now() - recording.startedAt) / 1000, status, data1, data2 });
	if (status === 0x90) paintRecorder();
}
function paintRecorder(): void {
	recButtons.start.disabled = !!recording;
	recButtons.stop.disabled = !recording;
	for (const button of [recButtons.play, recButtons.download, recButtons.clear])
		button.disabled = !!recording || take.length === 0;
	const duration = take.length ? take[take.length - 1].time : 0;
	element('recStatus').textContent = recording
		? t('recRecording', { notes: noteCount(recording.events) })
		: take.length
			? t('recTake', { notes: noteCount(take), duration: format(duration) })
			: t('recEmpty');
}
async function startRecording(): Promise<void> {
	if (recording || !(await ensureAudio())) return;
	if (current) stopSong();
	panic();
	recording = { startedAt: performance.now(), events: [] };
	paintRecorder();
}
/** end the take: notes and pedal still down are released at the end, and the silence before the first note is cut */
function finishRecording(): void {
	if (!recording) return;
	const events = recording.events;
	const end = (performance.now() - recording.startedAt) / 1000;
	recording = undefined;
	const open = new Set<number>();
	let pedal = false;
	for (const { status, data1, data2 } of events) {
		if (status === 0x90 && data2 > 0) open.add(data1);
		else if (status === 0x80) open.delete(data1);
		else if (status === 0xb0) pedal = data2 >= 64;
	}
	for (const note of open) events.push({ time: end, status: 0x80, data1: note, data2: 0 });
	if (pedal) events.push({ time: end, status: 0xb0, data1: 64, data2: 0 });
	if (noteCount(events) === 0) {
		take = [];
		say('recNone');
	} else {
		const start = events[0].time;
		take = events.map((event) => ({ ...event, time: event.time - start }));
		say('recTake', { notes: noteCount(take), duration: format(take[take.length - 1].time) });
	}
	paintRecorder();
}
/** the take replays through the song player: same sound, same model switching to compare */
async function replayTake(): Promise<void> {
	if (!take.length) return;
	takeEntry = {
		key: 'take',
		kind: 'take',
		title: () => t('recSong'),
		song: () => ({ events: take, duration: take[take.length - 1].time }),
	};
	buildSongList();
	await playSong('take');
}
function downloadTake(): void {
	if (!take.length) return;
	const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
	const name = `mwg-recording-${stamp}.mid`;
	saveBlob(new Blob([writeSmf(take, { title: 'mwg-retro-audio' })], { type: 'audio/midi' }), name);
}
recButtons.start.addEventListener('click', () => void startRecording(), options);
recButtons.stop.addEventListener('click', finishRecording, options);
recButtons.play.addEventListener('click', () => void replayTake(), options);
recButtons.download.addEventListener('click', downloadTake, options);
exportButton.addEventListener('click', () => void exportSong(), options);
songSelect.addEventListener('change', paintExport, options);
element<HTMLSelectElement>('songVoice').addEventListener(
	'change',
	() => {
		if (current) void playSong(current.key);
	},
	options,
);
recButtons.clear.addEventListener(
	'click',
	() => {
		take = [];
		paintRecorder();
		say('recEmpty');
	},
	options,
);
let midiAccess: MIDIAccess | undefined;
const midiSelect = element<HTMLSelectElement>('midiInput');
function refreshMidi(): void {
	panic();
	const selected = midiSelect.value;
	midiSelect.replaceChildren(new Option(t('midiNone'), ''));
	for (const input of midiAccess?.inputs.values() ?? []) {
		input.onmidimessage = null;
		midiSelect.add(new Option(input.name ?? input.id, input.id));
	}
	midiSelect.value = [...midiSelect.options].some((option) => option.value === selected) ? selected : '';
	bindMidi();
}
function bindMidi(): void {
	panic();
	if (!midiSelect.value) finishRecording();
	paintRecorder();
	for (const input of midiAccess?.inputs.values() ?? []) {
		input.onmidimessage =
			input.id !== midiSelect.value
				? null
				: ({ data }) => {
						if (!data || data.length < 3) return;
						const [command, note, velocity] = data;
						const kind = command & 0xf0;
						const source = `midi:${command & 15}:${note}`;
						if (kind === 0x90 && velocity > 0) press(source, note, velocity);
						else if (kind === 0x80 || kind === 0x90) release(source);
						else if (kind === 0xb0 && note === 64) {
							instrument.sustain(velocity >= 64);
							recordMessage(0xb0, 64, velocity);
						} else if (kind === 0xb0 && (note === 120 || note === 123)) panic();
					};
	}
}
midiSelect.addEventListener('change', bindMidi, options);
element('midi').addEventListener(
	'click',
	async () => {
		try {
			const navigatorMidi = navigator;
			if (!navigatorMidi.requestMIDIAccess) {
				say('midiMissing');
				return;
			}
			midiAccess ??= await navigatorMidi.requestMIDIAccess();
			midiAccess.onstatechange = refreshMidi;
			refreshMidi();
			say('midiOk');
		} catch (error) {
			say('midiFail', { error: String(error) });
		}
	},
	options,
);
document.addEventListener(
	'visibilitychange',
	() => {
		if (document.hidden) panic();
	},
	options,
);
window.addEventListener(
	'pagehide',
	() => {
		panic();
		clearInterval(ticker);
		stream?.stop();
		exportWorker?.terminate();
		gain?.disconnect();
		void context?.close();
		lifetime.abort();
		if (midiAccess) {
			midiAccess.onstatechange = null;
			for (const input of midiAccess.inputs.values()) input.onmidimessage = null;
		}
	},
	{ once: true },
);
const langSelect = element<HTMLSelectElement>('lang');
for (const { code, label } of languages) langSelect.add(new Option(label, code));
/** translate the page and everything built from texts, keeping the model, the song and the sound as they are */
function applyLanguage(code: Lang): void {
	setLang(code);
	langSelect.value = code;
	translatePage();
	buildModelList();
	buildSongList();
	describe();
	paintSong();
	controls();
	refreshMidiLabel();
	paintKeysHelp();
	paintRecorder();
	paintRandomModels();
	paintPanic();
	buildBankList();
	paintExport();
	status.value = t(said.key, said.values);
}
function refreshMidiLabel(): void {
	const none = midiSelect.querySelector<HTMLOptionElement>('option[value=""]');
	if (none) none.textContent = t('midiNone');
}
langSelect.addEventListener('change', () => applyLanguage(langSelect.value as Lang), options);
drawKeyboard();
choose();
try {
	const saved = localStorage.getItem(layoutStorage);
	if (saved && [...layoutSelect.options].some((option) => option.value === saved)) layoutSelect.value = saved;
} catch {
	// storage blocked: automatic layout
}
layoutSelect.addEventListener(
	'change',
	() => {
		try {
			localStorage.setItem(layoutStorage, layoutSelect.value);
		} catch {
			// not remembered
		}
		paintLayout();
	},
	options,
);
applyLanguage(initialLang());
void applySharedLink();
// Chromium can name the keys of the real layout (Dvorak, Bépo, Swiss...); elsewhere the guess above applies
void (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<typeof layoutMap> } }).keyboard
	?.getLayoutMap()
	.then((map) => {
		layoutMap = map;
		paintLayout();
	})
	.catch(() => undefined);

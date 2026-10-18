import { instrumentCatalogue } from '../../src/instruments/catalogue.ts';
import type { Instrument } from '../../src/instruments/Instrument.ts';
import { RetroStream } from '../../src/driver/RetroStream.ts';
import { InstrumentMidiSink } from '../../src/instruments/InstrumentMidiSink.ts';
import { isXmi, MidiPlayer, parseSmf, trimLeadingSilence, xmiToSmf } from '../../src/formats/midi.ts';
import type { MidiEvent, MidiSong } from '../../src/formats/midi.ts';
import { writeSmf } from '../../src/formats/midiWrite.ts';
import { renderPlayer } from '../../src/driver/Renderer.ts';
import { AUDIO_FORMATS, exportAudioBlob } from '../../src/driver/export.ts';
import type { AudioFormat } from '../../src/driver/export.ts';
import { isOpusEncodingAvailable } from '../../src/driver/opus.ts';
import type { RetroPlayer } from '../../src/players/Player.ts';
import { Region } from '../../src/region.ts';
import { describeMachines, featured, groupOrder, machines, names } from './machines.ts';
import { currentLang, initialLang, languages, setLang, t, translatePage } from './i18n.ts';
import type { Key, Lang } from './i18n.ts';
import { songs } from './songs.ts';

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const model = element<HTMLSelectElement>('model');
const octave = element<HTMLInputElement>('octave');
const status = element<HTMLOutputElement>('status');
const keyboard = element<HTMLDivElement>('keyboard');
const held = new Map<string, number>();
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
	instrument = instrumentCatalogue
		.find((definition) => definition.info.id === model.value)!
		.create({ sampleRate: context?.sampleRate ?? 44100 });
	instrument.onChange = controls;
	element('description').textContent = instrument.info.description;
	describe();
	controls();
	presets();
	paintMachines();
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
	model.value = selected;
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
/** the instrument a song plays on: the chosen model, or the plain piano for a take set to the standard voice */
function voiceFor(key: string): Instrument {
	if (key === 'take' && element<HTMLSelectElement>('recVoice').value === 'standard')
		return instrumentCatalogue
			.find((definition) => definition.info.id === 'simple:Piano')!
			.create({
				sampleRate: context?.sampleRate ?? 44100,
			});
	return instrument;
}
function paintSong(): void {
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
		if (gain)
			gain.gain.setTargetAtTime(Number((event.target as HTMLInputElement).value), context!.currentTime, 0.01);
	},
	options,
);
element('panic').addEventListener('click', panic, options);
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
const recButtons = {
	start: element<HTMLButtonElement>('recStart'),
	stop: element<HTMLButtonElement>('recStop'),
	play: element<HTMLButtonElement>('recPlay'),
	download: element<HTMLButtonElement>('recDownload'),
	clear: element<HTMLButtonElement>('recClear'),
	export: element<HTMLButtonElement>('recExport'),
};
let exporting = false;
const recFormat = element<HTMLSelectElement>('recFormat');
// Opus needs WebCodecs: the option is greyed out where the browser cannot encode it
void isOpusEncodingAvailable().then((available) => {
	const option = recFormat.querySelector<HTMLOptionElement>('option[value="opus"]')!;
	option.disabled = !available;
	option.title = available ? '' : t('recOpusMissing');
	if (!available && recFormat.value === 'opus') recFormat.value = 'flac';
});
const formatSize = (bytes: number): string =>
	bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** a copy of the live instrument for an offline render: same model, same settings, and no disturbing the live notes */
function offlineVoice(rate: number): Instrument {
	const key = element<HTMLSelectElement>('recVoice').value === 'standard' ? 'simple:Piano' : instrument.info.id;
	const copy = instrumentCatalogue.find((definition) => definition.info.id === key)!.create({ sampleRate: rate });
	if (key === instrument.info.id)
		for (const { id, get } of instrument.controls.map((control) => ({ id: control.id, get: () => control.get() })))
			(
				copy.controls.find((control) => control.id === id) as { set(value: number | boolean): void } | undefined
			)?.set(get());
	return copy;
}
/** render the take offline through the chosen voice and download it as FLAC, Opus or WAV */
async function exportTake(): Promise<void> {
	if (!take.length || exporting) return;
	const kind = recFormat.value as AudioFormat;
	exporting = true;
	paintRecorder();
	say('recExporting', { format: kind.toUpperCase() });
	try {
		const rate = context?.sampleRate ?? 44100;
		const duration = take[take.length - 1].time;
		const voice = offlineVoice(rate);
		const player = new MidiPlayer({ events: take, duration }, { sampleRate: rate }, new InstrumentMidiSink(voice));
		const rendered = renderPlayer(player, { maxSeconds: duration + 2, fadeOut: 0.05 });
		const blob = await exportAudioBlob(rendered, kind, {
			tags: { TITLE: 'mwg-retro-audio recording', COMMENT: voice.info.name },
		});
		const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
		saveBlob(blob, `mwg-recording-${stamp}.${AUDIO_FORMATS[kind].extension}`);
	} catch (error) {
		say('recExportFail', { error: String(error) });
	} finally {
		exporting = false;
		paintRecorder();
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
	for (const button of [recButtons.play, recButtons.download, recButtons.clear, recButtons.export])
		button.disabled = !!recording || take.length === 0 || (button === recButtons.export && exporting);
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
recButtons.export.addEventListener('click', () => void exportTake(), options);
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
// Chromium can name the keys of the real layout (Dvorak, Bépo, Swiss...); elsewhere the guess above applies
void (navigator as Navigator & { keyboard?: { getLayoutMap(): Promise<typeof layoutMap> } }).keyboard
	?.getLayoutMap()
	.then((map) => {
		layoutMap = map;
		paintLayout();
	})
	.catch(() => undefined);

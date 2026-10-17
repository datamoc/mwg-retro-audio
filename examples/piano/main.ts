import { instrumentCatalogue } from '../../src/instruments/catalogue.ts';
import type { Instrument } from '../../src/instruments/Instrument.ts';
import { RetroStream } from '../../src/driver/RetroStream.ts';
import { InstrumentMidiSink } from '../../src/instruments/InstrumentMidiSink.ts';
import { isXmi, MidiPlayer, parseSmf, xmiToSmf } from '../../src/formats/midi.ts';
import type { MidiSong } from '../../src/formats/midi.ts';
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
let current: { song: MidiSong; title: string; index: number } | undefined;
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
	held.set(source, note);
	instrument.noteOn(note, velocity);
	paintNotes();
}
function release(source: string): void {
	const note = held.get(source);
	if (note === undefined) return;
	held.delete(source);
	if (![...held.values()].includes(note)) instrument.noteOff(note);
	paintNotes();
}
function panic(): void {
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
		button.innerHTML = `<span>${offset < shortcuts.length ? keyLabel(shortcuts[offset]) : names[note % 12]}</span>`;
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
function songPlayer(song: MidiSong): RetroPlayer {
	return new MidiPlayer(song, { sampleRate: context!.sampleRate }, new InstrumentMidiSink(instrument));
}
/** (re)start the audio stream: the current song when there is one, the keyboard alone otherwise */
function attach(): void {
	stream?.stop();
	stream = undefined;
	if (!context || !gain) return;
	const created = new RetroStream(context, gain, current ? songPlayer(current.song) : livePlayer(), {
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
let customSong: { song: MidiSong; title: string } | undefined;
const format = (seconds: number): string =>
	`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const readSong = (bytes: Uint8Array): MidiSong => parseSmf(isXmi(bytes) ? xmiToSmf(bytes) : bytes);

function buildSongList(): void {
	const selected = songSelect.value;
	songSelect.replaceChildren();
	if (customSong) songSelect.add(new Option(customSong.title, 'file'));
	for (const [index, { title }] of songs.entries()) songSelect.add(new Option(title[currentLang()], String(index)));
	songSelect.value = selected || '0';
}
buildSongList();
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
		name: instrument.info.name,
	});
}
/** play bundled song `index`, or the file the user opened when `index` is -1 */
async function playSong(index: number): Promise<void> {
	if (!(await ensureAudio())) return;
	panic();
	const source =
		index < 0 ? customSong! : { title: songs[index].title[currentLang()], song: readSong(songs[index].bytes) };
	current = { ...source, index };
	songSelect.value = index < 0 ? 'file' : String(index);
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
function nextSong(): void {
	if (!current) return;
	if (!chain.checked) return stopSong();
	void playSong(current.index < 0 ? 0 : (current.index + 1) % songs.length);
}
playButton.addEventListener(
	'click',
	() => void playSong(songSelect.value === 'file' ? -1 : Number(songSelect.value)),
	options,
);
songSelect.addEventListener(
	'change',
	() => void playSong(songSelect.value === 'file' ? -1 : Number(songSelect.value)),
	options,
);
stopButton.addEventListener('click', stopSong, options);
element<HTMLInputElement>('file').addEventListener(
	'change',
	async (event) => {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;
		try {
			customSong = { song: readSong(new Uint8Array(await file.arrayBuffer())), title: file.name };
		} catch (error) {
			say('fileBad', { error: String(error) });
			return;
		}
		songSelect.querySelector('option[value="file"]')?.remove();
		songSelect.add(new Option(file.name, 'file'), 0);
		await playSong(-1);
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
						else if (kind === 0xb0 && note === 64) instrument.sustain(velocity >= 64);
						else if (kind === 0xb0 && (note === 120 || note === 123)) panic();
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

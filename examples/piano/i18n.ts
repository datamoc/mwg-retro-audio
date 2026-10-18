/** Interface texts of the demo in French, English and German. The generators' own names, presets and settings come from the library (English). */
export type Lang = 'fr' | 'en' | 'de';
export const languages: readonly { code: Lang; label: string }[] = [
	{ code: 'fr', label: 'Français' },
	{ code: 'en', label: 'English' },
	{ code: 'de', label: 'Deutsch' },
];

const dictionary = {
	fr: {
		title: 'Le clavier de mwg-retro-audio',
		audio: 'Activer le son',
		model: 'Modèle',
		volume: 'Volume',
		panic: 'Couper les notes',
		byMachine: 'Choisir par machine',
		presetsAria: 'Sons préréglés du modèle',
		autoTitle: 'Lecture automatique',
		autoHelp:
			'Un morceau MIDI est joué par le modèle choisi ci-dessus ; changez de modèle pendant l’écoute pour comparer (le morceau repart du début). Sur les puces à peu de voix, seules la mélodie et la basse sont gardées ; les percussions sont omises.',
		song: 'Morceau',
		play: '▶ Lire',
		playAgain: '↻ Depuis le début',
		stop: '■ Arrêter',
		chain: 'Enchaîner les morceaux',
		file: 'Votre fichier .mid',
		progress: 'Progression du morceau',
		keyboardAria: 'Clavier de piano',
		keysHelp: 'Clavier : {keys}. Octave : {octaveKeys}. La souris et le clavier MIDI peuvent jouer ensemble.',
		octave: 'Octave',
		layout: 'Disposition du clavier',
		layoutAuto: 'Automatique',
		recTitle: 'Enregistrement MIDI',
		recHelp:
			'Enregistrez ce que vous jouez (clavier MIDI, souris ou clavier d’ordinateur), réécoutez-le sur le modèle choisi (changez de modèle pour comparer) puis téléchargez-le en fichier .mid.',
		recStart: '● Enregistrer',
		recStop: '■ Terminer',
		recPlay: '▶ Réécouter',
		recDownload: '⬇ Télécharger .mid',
		recClear: 'Effacer',
		recEmpty: 'Aucun enregistrement.',
		recRecording: 'Enregistrement en cours… {notes} notes',
		recTake: 'Enregistrement : {notes} notes, {duration}.',
		recNone: 'Rien n’a été joué : enregistrement ignoré.',
		recSong: 'Mon enregistrement',
		recSaved: 'Fichier {name} téléchargé.',
		midiConnect: 'Connecter MIDI',
		midiInput: 'Entrée MIDI',
		midiNone: 'Aucune',
		reset: 'Réglages par défaut',
		idle: 'Activez le son, puis jouez une note.',
		settings: 'Réglages du modèle',
		credits:
			'Morceaux MIDI : Theme Song [8-bit] — nene (CC0, opengameart.org/node/84462) ; Ancient Mysteries — Sperry Lion, LLC, 2024 (CC0, opengameart.org/content/ancient-mysteries) ; Marche turque (Mozart), Les Sauvages (Rameau), Symphonies n°5 et n°7 (Beethoven), Gymnopédie n°1 (Satie) — domaine public, saisies Mutopia Project ; Méditation de Thaïs (Massenet, domaine public) — fichier MIDI d’origine non identifiée.',
		langAria: 'Langue',
		value: '{value} {unit} (défaut {def} ; {min}–{max})',
		info: '{name} — {voices} voix ; {era}',
		soundOn: 'Son actif. Jouez au clavier, à la souris ou en MIDI.',
		presetApplied: 'Son « {name} » appliqué.',
		playing: 'Lecture : {title}.',
		stopped: 'Lecture arrêtée.',
		clock: '{title} — {elapsed} / {total} sur {name}',
		midiOk: 'MIDI autorisé. Choisissez une entrée ; activez le son si nécessaire.',
		midiFail: 'MIDI non connecté : {error}. Le clavier et la souris restent utilisables.',
		midiMissing: 'Web MIDI indisponible ; le clavier et la souris restent utilisables.',
		fileBad: 'Fichier MIDI illisible : {error}',
		computers: 'Ordinateurs',
		consoles: 'Consoles',
		cards: 'Cartes son',
		synths: 'Synthétiseurs',
		simple: 'Profils simples',
		other: 'Aussi',
		lateRevision: 'révision tardive',
		board: 'carte',
		card: 'carte',
		cartridge: 'cartouche',
		arcade: 'Bornes d’arcade',
		keyboard: 'clavier',
		module: 'module',
		calculator: 'calculatrice musicale',
		research: 'recherche',
	},
	en: {
		title: 'The mwg-retro-audio keyboard',
		audio: 'Turn sound on',
		model: 'Model',
		volume: 'Volume',
		panic: 'Stop all notes',
		byMachine: 'Pick by machine',
		presetsAria: 'Preset sounds of the model',
		autoTitle: 'Autoplay',
		autoHelp:
			'A MIDI song is played by the model chosen above; switch model while it plays to compare (the song restarts from the beginning). On chips with few voices only the melody and the bass are kept; percussion is left out.',
		song: 'Song',
		play: '▶ Play',
		playAgain: '↻ From the start',
		stop: '■ Stop',
		chain: 'Play songs one after another',
		file: 'Your .mid file',
		progress: 'Song progress',
		keyboardAria: 'Piano keyboard',
		keysHelp: 'Keys: {keys}. Octave: {octaveKeys}. Mouse and MIDI keyboard can play together.',
		octave: 'Octave',
		layout: 'Keyboard layout',
		layoutAuto: 'Automatic',
		recTitle: 'MIDI recording',
		recHelp:
			'Record what you play (MIDI keyboard, mouse or computer keyboard), listen to it again on the chosen model (switch model to compare), then download it as a .mid file.',
		recStart: '● Record',
		recStop: '■ Finish',
		recPlay: '▶ Play back',
		recDownload: '⬇ Download .mid',
		recClear: 'Clear',
		recEmpty: 'Nothing recorded.',
		recRecording: 'Recording… {notes} notes',
		recTake: 'Recording: {notes} notes, {duration}.',
		recNone: 'Nothing was played: recording discarded.',
		recSong: 'My recording',
		recSaved: 'File {name} downloaded.',
		midiConnect: 'Connect MIDI',
		midiInput: 'MIDI input',
		midiNone: 'None',
		reset: 'Default settings',
		idle: 'Turn the sound on, then play a note.',
		settings: 'Model settings',
		credits:
			'MIDI songs: Theme Song [8-bit] — nene (CC0, opengameart.org/node/84462); Ancient Mysteries — Sperry Lion, LLC, 2024 (CC0, opengameart.org/content/ancient-mysteries); Turkish March (Mozart), Les Sauvages (Rameau), Symphonies No. 5 and No. 7 (Beethoven), Gymnopédie No. 1 (Satie) — public domain, Mutopia Project transcriptions; Méditation from Thaïs (Massenet, public domain) — MIDI file of unidentified origin.',
		langAria: 'Language',
		value: '{value} {unit} (default {def}; {min}–{max})',
		info: '{name} — {voices} voices; {era}',
		soundOn: 'Sound is on. Play with the keyboard, the mouse or MIDI.',
		presetApplied: 'Sound “{name}” applied.',
		playing: 'Playing: {title}.',
		stopped: 'Playback stopped.',
		clock: '{title} — {elapsed} / {total} on {name}',
		midiOk: 'MIDI allowed. Choose an input; turn the sound on if needed.',
		midiFail: 'MIDI not connected: {error}. Keyboard and mouse still work.',
		midiMissing: 'Web MIDI is unavailable; keyboard and mouse still work.',
		fileBad: 'Unreadable MIDI file: {error}',
		computers: 'Computers',
		consoles: 'Consoles',
		cards: 'Sound cards',
		synths: 'Synthesizers',
		simple: 'Simple profiles',
		other: 'Also',
		lateRevision: 'late revision',
		board: 'board',
		card: 'card',
		cartridge: 'cartridge',
		arcade: 'Arcade machines',
		keyboard: 'keyboard',
		module: 'module',
		calculator: 'musical calculator',
		research: 'research',
	},
	de: {
		title: 'Die Tastatur von mwg-retro-audio',
		audio: 'Ton einschalten',
		model: 'Modell',
		volume: 'Lautstärke',
		panic: 'Alle Töne stoppen',
		byMachine: 'Nach Gerät wählen',
		presetsAria: 'Voreingestellte Klänge des Modells',
		autoTitle: 'Automatische Wiedergabe',
		autoHelp:
			'Ein MIDI-Stück wird vom oben gewählten Modell gespielt; wechseln Sie das Modell während der Wiedergabe, um zu vergleichen (das Stück beginnt von vorn). Bei Chips mit wenigen Stimmen bleiben nur Melodie und Bass erhalten; Schlagzeug entfällt.',
		song: 'Stück',
		play: '▶ Abspielen',
		playAgain: '↻ Von vorn',
		stop: '■ Stopp',
		chain: 'Stücke nacheinander spielen',
		file: 'Ihre .mid-Datei',
		progress: 'Fortschritt des Stücks',
		keyboardAria: 'Klaviertastatur',
		keysHelp: 'Tasten: {keys}. Oktave: {octaveKeys}. Maus und MIDI-Keyboard lassen sich gleichzeitig spielen.',
		octave: 'Oktave',
		layout: 'Tastaturbelegung',
		layoutAuto: 'Automatisch',
		recTitle: 'MIDI-Aufnahme',
		recHelp:
			'Nehmen Sie auf, was Sie spielen (MIDI-Keyboard, Maus oder Computertastatur), hören Sie es auf dem gewählten Modell erneut an (Modell wechseln zum Vergleichen) und laden Sie es als .mid-Datei herunter.',
		recStart: '● Aufnehmen',
		recStop: '■ Beenden',
		recPlay: '▶ Anhören',
		recDownload: '⬇ .mid herunterladen',
		recClear: 'Löschen',
		recEmpty: 'Keine Aufnahme.',
		recRecording: 'Aufnahme läuft… {notes} Noten',
		recTake: 'Aufnahme: {notes} Noten, {duration}.',
		recNone: 'Es wurde nichts gespielt: Aufnahme verworfen.',
		recSong: 'Meine Aufnahme',
		recSaved: 'Datei {name} heruntergeladen.',
		midiConnect: 'MIDI verbinden',
		midiInput: 'MIDI-Eingang',
		midiNone: 'Keiner',
		reset: 'Standardeinstellungen',
		idle: 'Schalten Sie den Ton ein und spielen Sie dann eine Note.',
		settings: 'Einstellungen des Modells',
		credits:
			'MIDI-Stücke: Theme Song [8-bit] — nene (CC0, opengameart.org/node/84462); Ancient Mysteries — Sperry Lion, LLC, 2024 (CC0, opengameart.org/content/ancient-mysteries); Türkischer Marsch (Mozart), Les Sauvages (Rameau), Sinfonien Nr. 5 und Nr. 7 (Beethoven), Gymnopédie Nr. 1 (Satie) — gemeinfrei, Notensatz des Mutopia Project; Méditation aus Thaïs (Massenet, gemeinfrei) — MIDI-Datei unbekannter Herkunft.',
		langAria: 'Sprache',
		value: '{value} {unit} (Standard {def}; {min}–{max})',
		info: '{name} — {voices} Stimmen; {era}',
		soundOn: 'Ton ist an. Spielen Sie mit Tastatur, Maus oder MIDI.',
		presetApplied: 'Klang „{name}“ angewendet.',
		playing: 'Wiedergabe: {title}.',
		stopped: 'Wiedergabe gestoppt.',
		clock: '{title} — {elapsed} / {total} auf {name}',
		midiOk: 'MIDI erlaubt. Wählen Sie einen Eingang; schalten Sie bei Bedarf den Ton ein.',
		midiFail: 'MIDI nicht verbunden: {error}. Tastatur und Maus funktionieren weiterhin.',
		midiMissing: 'Web MIDI ist nicht verfügbar; Tastatur und Maus funktionieren weiterhin.',
		fileBad: 'MIDI-Datei nicht lesbar: {error}',
		computers: 'Computer',
		consoles: 'Konsolen',
		cards: 'Soundkarten',
		synths: 'Synthesizer',
		simple: 'Einfache Profile',
		other: 'Außerdem',
		lateRevision: 'späte Revision',
		board: 'Karte',
		card: 'Karte',
		cartridge: 'Modul',
		arcade: 'Spielautomaten',
		keyboard: 'Keyboard',
		module: 'Modul',
		calculator: 'Musikrechner',
		research: 'Forschung',
	},
} as const;

export type Key = keyof (typeof dictionary)['fr'];
const storage = 'mwg-retro-audio-demo-lang';

let language: Lang = 'fr';

export function currentLang(): Lang {
	return language;
}

export function setLang(code: Lang): void {
	language = code;
	document.documentElement.lang = code;
	try {
		localStorage.setItem(storage, code);
	} catch {
		// private mode: the choice is simply not remembered
	}
}

/** saved choice, else the browser language when it is one of ours, else English */
export function initialLang(): Lang {
	try {
		const saved = localStorage.getItem(storage);
		if (saved && saved in dictionary) return saved as Lang;
	} catch {
		// storage blocked
	}
	const preferred = (navigator.languages?.[0] ?? navigator.language ?? 'en').slice(0, 2);
	return preferred in dictionary ? (preferred as Lang) : 'en';
}

/** a text in the current language; `{name}` placeholders take their value from `values` */
export function t(key: Key, values: Record<string, string | number> = {}): string {
	return dictionary[language][key].replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ''));
}

/** text with `{word}` placeholders naming dictionary entries (machine names: 'Famicom ({cartridge} Konami)') */
export function words(text: string): string {
	return text.replace(/\{(\w+)\}/g, (_match, name: string) =>
		name in dictionary[language] ? dictionary[language][name as Key] : name,
	);
}

/** fill every `data-i18n` (text), `data-i18n-aria` (aria-label) and `data-i18n-title` element, and the page title */
export function translatePage(): void {
	for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]'))
		node.textContent = t(node.dataset.i18n as Key);
	for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]'))
		node.setAttribute('aria-label', t(node.dataset.i18nAria as Key));
	document.title = t('title');
}

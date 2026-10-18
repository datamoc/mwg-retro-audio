/**
 * Export du morceau sélectionné : rendu hors ligne puis encodage FLAC, Opus ou WAV,
 * dans un fil séparé pour que la page continue de jouer pendant le calcul.
 * Le texte compilé de ce module est embarqué dans la page par tools/worker-plugin.mjs.
 */
import { parseSf2 } from '../../src/formats/soundfont.ts';
import { soundFontInstruments } from '../../src/instruments/soundfont.ts';
import { instrumentCatalogue } from '../../src/instruments/catalogue.ts';
import type { Instrument, InstrumentDef } from '../../src/instruments/Instrument.ts';
import { InstrumentMidiSink } from '../../src/instruments/InstrumentMidiSink.ts';
import { MidiPlayer } from '../../src/formats/midi.ts';
import type { MidiEvent, MidiSong } from '../../src/formats/midi.ts';
import { renderPlayerAsync } from '../../src/driver/Renderer.ts';
import { exportAudioBlob } from '../../src/driver/export.ts';
import type { AudioFormat } from '../../src/driver/export.ts';

/** la voix à récréer dans le fil : un modèle du catalogue, ou un préréglage de banque sur ses octets */
export interface ExportVoice {
	/** id du modèle, ou `soundfont:<banque>:<préréglage>` quand `bank` est présent */
	id: string;
	/** réglages à recopier sur la copie silencieuse : [id du réglage, valeur] */
	controls: [string, number | boolean][];
	/** banque ouverte sur la page : l'octet original que la page avait lu, pour le relire ici */
	bank?: { bytes: ArrayBuffer; id: string; preset: number };
}

export interface ExportRequest {
	/** identifiant de la requête ; la page n'exporte qu'un morceau à la fois */
	id: number;
	voice: ExportVoice;
	events: MidiEvent[];
	duration: number;
	sampleRate: number;
	format: AudioFormat;
	title: string;
	comment: string;
}

/** réponse du fil : progression, résultat transféré, ou erreur à réessayer sur la page */
export interface ExportReply {
	id?: number;
	progress?: number;
	buffer?: ArrayBuffer;
	mime?: string;
	error?: string;
}

const scope = globalThis as unknown as {
	postMessage(message: ExportReply, transfer?: Transferable[]): void;
	onmessage: ((event: MessageEvent) => void) | null;
};

/** une copie muette du modèle demandé : la banque est relue ici, ses octets voyagent vers le fil */
function silentVoice(voice: ExportVoice, sampleRate: number): Instrument {
	let definition: InstrumentDef | undefined;
	if (voice.bank) {
		// un objet SoundFont (avec ses méthodes) ne se clone pas entre fils : on relit le fichier
		const font = parseSf2(new Uint8Array(voice.bank.bytes));
		definition = soundFontInstruments(font, voice.bank.id)[voice.bank.preset];
	}
	if (!definition) definition = instrumentCatalogue.find((entry) => entry.info.id === voice.id);
	if (!definition) throw new Error(`unknown model: ${voice.id}`);
	const instrument = definition.create({ sampleRate });
	for (const [id, value] of voice.controls) {
		const control = instrument.controls.find((entry) => entry.id === id) as
			| { set(value: number | boolean): void }
			| undefined;
		if (control) control.set(value);
	}
	return instrument;
}

scope.onmessage = async (event: MessageEvent) => {
	const request = event.data as ExportRequest;
	try {
		const instrument = silentVoice(request.voice, request.sampleRate);
		const song: MidiSong = { events: request.events, duration: request.duration };
		const player = new MidiPlayer(song, { sampleRate: request.sampleRate }, new InstrumentMidiSink(instrument));
		const rendered = await renderPlayerAsync(player, {
			maxSeconds: request.duration + 2,
			fadeOut: 0.05,
			onProgress: (fraction) => scope.postMessage({ id: request.id, progress: fraction }),
		});
		const blob = await exportAudioBlob(rendered, request.format, {
			tags: { TITLE: request.title, COMMENT: request.comment },
		});
		const buffer = await blob.arrayBuffer();
		scope.postMessage({ id: request.id, buffer, mime: blob.type }, [buffer]);
	} catch (error) {
		scope.postMessage({ id: request.id, error: String(error) });
	}
};

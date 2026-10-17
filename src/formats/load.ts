import type { RetroPlayer } from '../players/Player.ts';
import { renderPlayer } from '../driver/Renderer.ts';
import { isCmf, parseCmf } from './cmf.ts';
import { isD00, parseD00 } from './d00.ts';
import { looksLikeHsc, parseHsc } from './hsc.ts';
import { isRad, parseRad } from './rad.ts';
import { isRol, parseRol } from './rol.ts';
import { isSci0Sound, parseSci0 } from './sci.ts';
import { isLha } from './lha.ts';
import { MwaPlayer, MwaRecorder, decodeMwa, encodeMwa, isMwa, type LoadOptions, type MwaData } from './mwa.ts';
import { isSmf, isXmi, loadMidi } from './midi.ts';
import { isSpc, loadSpc } from './spc.ts';
import { isNsf, loadNsf, type NsfOptions } from './nsf.ts';
import { isDro, parseDro, parseImf } from './opl-logs.ts';
import { isVoc, isWav, loadVoc, loadWav } from './pcm.ts';
import { isPsid, loadPsid, type PsidOptions } from './psid.ts';
import { isIt, loadIt } from './tracker/it.ts';
import { isMod, loadMod } from './tracker/mod.ts';
import type { ModuleOptions } from './tracker/player.ts';
import { isXm, loadXm } from './tracker/xm.ts';
import { isS3m, loadS3m } from './tracker/s3m.ts';
import { isVgm, loadVgm } from './vgm.ts';
import { isYm, loadYm } from './ym.ts';

export type FormatName =
	| 'mwa'
	| 'hsc'
	| 'rad'
	| 'sci'
	| 'd00'
	| 'rol'
	| 'ym'
	| 'vgm'
	| 'nsf'
	| 'psid'
	| 'mod'
	| 'xm'
	| 's3m'
	| 'midi'
	| 'spc'
	| 'it'
	| 'dro'
	| 'imf'
	| 'cmf'
	| 'wav'
	| 'voc'
	| 'unknown';

/** Options for `loadFile`: the union of the per-format options plus the file name used to tell magic-less formats */
export interface LoadFileOptions extends LoadOptions, NsfOptions, PsidOptions, ModuleOptions {
	/** file name (its extension decides for IMF, which has no signature) */
	name?: string;
	/** IMF delay counter rate: 560 (default), 700 or 280 Hz */
	imfRate?: number;
	/** `.bnk` instrument bank for a Visual Composer `.rol` song */
	bank?: Uint8Array;
	/** `patch.003` instrument bank for a Sierra SCI0 sound resource */
	sciPatch?: Uint8Array;
}

/** Recognise a file by its content (and its extension for formats without a signature) */
export function detectFormat(bytes: Uint8Array, name = ''): FormatName {
	const ext = name.toLowerCase().split('.').pop() ?? '';
	if (isMwa(bytes)) return 'mwa';
	if (isCmf(bytes)) return 'cmf';
	if (isSpc(bytes)) return 'spc';
	if (isSmf(bytes) || isXmi(bytes)) return 'midi';
	if (isRad(bytes)) return 'rad';
	if (isD00(bytes, name)) return 'd00';
	if (isRol(bytes, name)) return 'rol';
	if (isSci0Sound(bytes, name)) return 'sci';
	if (isDro(bytes)) return 'dro';
	if (isNsf(bytes)) return 'nsf';
	if (isPsid(bytes)) return 'psid';
	if (isVgm(bytes)) return 'vgm';
	if (isXm(bytes)) return 'xm';
	if (isIt(bytes)) return 'it';
	if (isS3m(bytes)) return 's3m';
	if (isWav(bytes)) return 'wav';
	if (isVoc(bytes)) return 'voc';
	if (isMod(bytes)) return 'mod';
	if (isLha(bytes) || isYm(bytes)) return 'ym';
	if (ext === 'imf' || ext === 'wlf') return 'imf';
	if (ext === 'hsc' && looksLikeHsc(bytes)) return 'hsc';
	return 'unknown';
}

/** Load any supported file into a player; throws for an unknown format */
export function loadFile(bytes: Uint8Array, options: LoadFileOptions = {}): RetroPlayer {
	const format = detectFormat(bytes, options.name);
	switch (format) {
		case 'mwa':
			return new MwaPlayer(decodeMwa(bytes), options);
		case 'ym':
			return loadYm(bytes, options);
		case 'vgm':
			return loadVgm(bytes, options);
		case 'nsf':
			return loadNsf(bytes, options);
		case 'psid':
			return loadPsid(bytes, options);
		case 'mod':
			return loadMod(bytes, options);
		case 'xm':
			return loadXm(bytes, options);
		case 'it':
			return loadIt(bytes, options);
		case 'spc':
			return loadSpc(bytes, options);
		case 'midi':
			return loadMidi(bytes, options);
		case 's3m':
			return loadS3m(bytes, options);
		case 'dro':
			return new MwaPlayer(parseDro(bytes), options);
		case 'imf':
			return new MwaPlayer(parseImf(bytes, options.imfRate ?? 560), options);
		case 'cmf':
			return new MwaPlayer(parseCmf(bytes), options);
		case 'rad':
			return new MwaPlayer(parseRad(bytes), options);
		case 'hsc':
			return new MwaPlayer(parseHsc(bytes), options);
		case 'd00':
			return new MwaPlayer(parseD00(bytes), options);
		case 'sci':
			if (!options.sciPatch)
				throw new Error('a SCI sound needs its patch.003 instrument bank (option `sciPatch`)');
			return new MwaPlayer(parseSci0(bytes, { patch: options.sciPatch }), options);
		case 'rol':
			if (!options.bank) throw new Error('a .rol song needs its .bnk instrument bank (option `bank`)');
			return new MwaPlayer(parseRol(bytes, options.bank), options);
		case 'wav':
			return loadWav(bytes, options);
		case 'voc':
			return loadVoc(bytes, options);
		default:
			throw new Error('unknown or unsupported audio format');
	}
}

export interface ConvertOptions extends LoadFileOptions {
	/** longest music to record, in seconds: needed for formats that never end (NSF, SID); default 180 */
	maxSeconds?: number;
}

/**
 * Convert any register-driven file to the universal MWA container: the file is played once with a recorder on its
 * chips, so the result is exactly what the source format wrote to the hardware. Formats made of samples (trackers,
 * WAV, VOC) have no register log and cannot be converted; play them directly or render them to audio.
 */
export async function convertToMwa(bytes: Uint8Array, options: ConvertOptions = {}): Promise<Uint8Array> {
	const format = detectFormat(bytes, options.name);
	if (format === 'mwa') return bytes;
	let data: MwaData;
	if (format === 'dro') data = parseDro(bytes);
	else if (format === 'imf') data = parseImf(bytes, options.imfRate ?? 560);
	else if (format === 'cmf') data = parseCmf(bytes);
	else if (format === 'rad') data = parseRad(bytes);
	else if (format === 'hsc') data = parseHsc(bytes);
	else if (format === 'd00') data = parseD00(bytes);
	else if (format === 'rol' && options.bank) data = parseRol(bytes, options.bank);
	else if (['ym', 'vgm', 'nsf', 'psid'].includes(format)) {
		const recorder = new MwaRecorder();
		const player = loadFile(bytes, { ...options, chipFactory: recorder.factory, loop: false });
		const max = options.maxSeconds ?? 180;
		renderPlayer(player, { maxSeconds: max });
		data = recorder.finish({
			frameRate: player.info.frameRate,
			title: player.info.title,
			author: player.info.author,
			comment: player.info.comment,
			loopStartSeconds: player.info.loopStartSeconds,
		});
	} else throw new Error(`format '${format}' has no register log to convert`);
	return encodeMwa(data);
}

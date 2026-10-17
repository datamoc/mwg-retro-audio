import { t, words } from './i18n.ts';

/** Where each generator of the catalogue was heard: the computers and the consoles that carried it. Demo data; `{word}` is translated by `words`. */
export interface Machines {
	/** section of the model list */
	group: 'computers' | 'consoles' | 'cards' | 'synths' | 'simple';
	computers?: readonly string[];
	consoles?: readonly string[];
	/** other places: arcade boards, instruments */
	other?: readonly string[];
}

export const machines: Readonly<Record<string, Machines>> = {
	ym2149: {
		group: 'computers',
		computers: ['Atari ST', 'Amstrad CPC', 'MSX', 'ZX Spectrum 128'],
	},
	ay8910: {
		group: 'computers',
		computers: ['ZX Spectrum 128', 'Amstrad CPC', 'MSX'],
		consoles: ['Intellivision', 'Vectrex'],
	},
	sid: { group: 'computers', computers: ['Commodore 64'] },
	'sid-8580': { group: 'computers', computers: ['Commodore 64 ({lateRevision})', 'Commodore 128'] },
	saa1099: { group: 'computers', computers: ['SAM Coupé'], other: ['Game Blaster'] },
	ym2203: { group: 'computers', computers: ['NEC PC-8801', 'NEC PC-9801 ({board} 26K)'] },
	ym2608: { group: 'computers', computers: ['NEC PC-8801 FA', 'NEC PC-9801 ({board} 86)'] },
	ym2151: { group: 'computers', computers: ['Sharp X68000'], other: ['{arcade} (Capcom, Sega)'] },
	'apple2-speaker': { group: 'computers', computers: ['Apple II'] },
	mockingboard: { group: 'computers', computers: ['Apple II ({card} Mockingboard)'] },
	'pc-speaker': { group: 'computers', computers: ['IBM PC'] },
	tandy: { group: 'computers', computers: ['Tandy 1000', 'IBM PCjr'] },
	sn76489: {
		group: 'consoles',
		computers: ['BBC Micro', 'TI-99/4A'],
		consoles: ['Master System', 'ColecoVision', 'Game Gear', 'Mega Drive (PSG)'],
	},
	'nes-apu': { group: 'consoles', consoles: ['Nintendo NES / Famicom (NTSC)'] },
	'nes-apu-pal': { group: 'consoles', consoles: ['Nintendo NES (PAL)'] },
	vrc6: { group: 'consoles', consoles: ['Famicom ({cartridge} Konami)'] },
	mmc5: { group: 'consoles', consoles: ['NES / Famicom ({cartridge} MMC5)'] },
	sunsoft5b: { group: 'consoles', consoles: ['Famicom ({cartridge} Sunsoft)'] },
	namco163: { group: 'consoles', consoles: ['Famicom ({cartridge} Namco)'] },
	fds: { group: 'consoles', consoles: ['Famicom Disk System'] },
	ym2612: { group: 'consoles', computers: ['FM Towns'], consoles: ['Mega Drive / Genesis'] },
	opl2: { group: 'cards', computers: ['PC (AdLib)'] },
	opl3: { group: 'cards', computers: ['PC (Sound Blaster Pro 2 / 16)'] },
	'sound-blaster': { group: 'cards', computers: ['PC (Sound Blaster 1.x / 2.0)'] },
	cms: { group: 'cards', computers: ['PC (Game Blaster)'] },
	'pcm-dac': { group: 'cards', computers: ['PC (Covox Speech Thing)'] },
	mt32: { group: 'synths', computers: ['PC', 'NEC PC-98'], other: ['Roland MT-32 ({module})'] },
	d50: { group: 'synths', other: ['Roland D-50 ({keyboard}, 1987)'] },
	m1: { group: 'synths', other: ['Korg M1 ({keyboard}, 1988)'] },
	gs1: { group: 'synths', other: ['Yamaha GS-1 ({keyboard}, 1981)'] },
	vl1: { group: 'synths', other: ['Casio VL-1 ({calculator}, 1979)'] },
	dx7: { group: 'synths', other: ['Yamaha DX7 ({keyboard}, 1983)'] },
	additive: { group: 'synths', other: ['Bell Labs ({research}, 1977)'] },
	dartmouth: { group: 'synths', other: ['Dartmouth College ({research}, 1972)'] },
	synclavier: { group: 'synths', other: ['New England Digital Synclavier'] },
	'la-synth': { group: 'synths', other: ['Roland LA'] },
	'ai-synth': { group: 'synths', other: ['Roland AI'] },
};

export const groupOrder: readonly Machines['group'][] = ['computers', 'consoles', 'cards', 'synths', 'simple'];

/** names of the machines, for display: « Atari ST, Amstrad CPC » */
export const names = (list: readonly string[] | undefined): string[] => (list ?? []).map(words);

/** « Computers: A, B — Consoles: C » */
export function describeMachines(id: string): string {
	const entry = machines[id];
	if (!entry) return '';
	const parts = [
		entry.computers?.length ? `${t('computers')}: ${names(entry.computers).join(', ')}` : '',
		entry.consoles?.length ? `${t('consoles')}: ${names(entry.consoles).join(', ')}` : '',
		entry.other?.length ? `${t('other')}: ${names(entry.other).join(', ')}` : '',
	];
	return parts.filter(Boolean).join(' — ');
}

/** Shortcuts put forward above the model list: a machine, and the generator it carries */
export const featured: readonly { label: string; model: string }[] = [
	{ label: 'Atari ST', model: 'ym2149' },
	{ label: 'Commodore 64', model: 'sid' },
	{ label: 'ZX Spectrum 128', model: 'ay8910' },
	{ label: 'NES', model: 'nes-apu' },
	{ label: 'Mega Drive', model: 'ym2612' },
	{ label: 'Master System', model: 'sn76489' },
	{ label: 'AdLib / PC', model: 'opl2' },
	{ label: 'Sharp X68000', model: 'ym2151' },
	{ label: 'Apple II', model: 'mockingboard' },
	{ label: 'Roland MT-32', model: 'mt32' },
];

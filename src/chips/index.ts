import type { Chip, ChipOptions } from './Chip.ts';
import { NesApu } from './NesApu.ts';
import { CmsCard, SoundBlasterCard } from './cards.ts';
import { Mmc5, Sunsoft5b, Vrc6 } from './NesExpansion.ts';
import { Fds, Namco163 } from './NesExpansion2.ts';
import { AppleSpeaker, Mockingboard } from './AppleII.ts';
import { Dx7Synth } from './Dx7.ts';
import { AdditiveSynth, AiSynth, D50Synth, Gs1, LaSynth, Synclavier, Vl1 } from './historical.ts';
import { M1Synth } from './M1.ts';
import { MicroKorgSynth } from './MicroKorg.ts';
import { Opl } from './Opl.ts';
import { Opn } from './Opn.ts';
import { PcmDac } from './PcmDac.ts';
import { PcSpeaker } from './PcSpeaker.ts';
import { Saa1099 } from './Saa1099.ts';
import { Sid } from './Sid.ts';
import { Sn76489 } from './Sn76489.ts';
import { Ym2149 } from './Ym2149.ts';
import { Ym2151 } from './Ym2151.ts';
import { Ym2612 } from './Ym2612.ts';

export type { Chip, ChipOptions } from './Chip.ts';
export { BoxRenderer } from './BoxRenderer.ts';
export { Ym2149, type Ym2149Options } from './Ym2149.ts';
export { Sn76489, type Sn76489Options } from './Sn76489.ts';
export { NesApu, type NesApuOptions } from './NesApu.ts';
export { Sid, type SidOptions } from './Sid.ts';
export { Opl, type OplOptions } from './Opl.ts';
export { Ym2612, type Ym2612Options } from './Ym2612.ts';
export { Ym2151 } from './Ym2151.ts';
export { Mt32Synth } from './Mt32Synth.ts';
export { M1Synth, M1_PRESETS, type M1Lfo, type M1Osc, type M1Program } from './M1.ts';
export { M1_ATTACKS, M1_LOOPS } from './m1Data.ts';
export { MicroKorgSynth, MICROKORG_PROGRAMS, type MicroKorgProgram } from './MicroKorg.ts';
export { Opn, type OpnOptions } from './Opn.ts';
export { AppleSpeaker, Mockingboard, type MockingboardOptions } from './AppleII.ts';
export {
	AdditiveSynth,
	AiSynth,
	BreakPointEnvelope,
	D50_ATTACKS,
	D50_PRESETS,
	D50Synth,
	GS1_PRESETS,
	Gs1,
	LaSynth,
	Synclavier,
	Vl1,
	noteHz,
	type AdditivePatch,
	type BreakPoints,
	type D50Attack,
	type D50Lfo,
	type D50Partial,
	type D50Patch,
	type D50Tone,
	type FilterVoiceParams,
	type Gs1Lfo,
	type Gs1Pair,
	type Gs1Patch,
	type PcmSource,
	type SynclavierPatch,
	type Vl1Sound,
} from './historical.ts';
export { Dx7Synth, DX7_CARRIERS, DX7_NATIVE_RATE, type Dx7Options, type Dx7Controller } from './Dx7.ts';
export { Vrc6, Sunsoft5b, Mmc5 } from './NesExpansion.ts';
export { Namco163, Fds } from './NesExpansion2.ts';
export { PcSpeaker, PIT_CLOCK } from './PcSpeaker.ts';
export { Saa1099, type Saa1099Options } from './Saa1099.ts';
export { PcmDac, type PcmDacOptions } from './PcmDac.ts';
export { CmsCard, SoundBlasterCard, type SoundCard, type CardOptions, type SoundBlasterOptions } from './cards.ts';

/** builds a chip from the options a player knows (clock, sample rate and chip specific extras) */
export type ChipFactory = (options: ChipOptions & Record<string, unknown>) => Chip;

const factories = new Map<string, ChipFactory>();

/**
 * Register (or replace) the implementation behind a chip id. This is how an alternative backend plugs in without
 * the core depending on it, for instance the cycle-exact GPL `hatari-ym` package for the 'ym2149' id:
 * `registerChip('ym2149', (o) => new HatariYm(o))`.
 */
export function registerChip(id: string, factory: ChipFactory): void {
	factories.set(id, factory);
}

// Builtins are data, not eager registration calls: named exports can be tree-shaken.
const builtins: Readonly<Record<string, ChipFactory>> = {
	ym2149: (o) => new Ym2149(o),
	ay8910: (o) => new Ym2149({ ...o, model: 'ay8910' }),
	sn76489: (o) => new Sn76489(o),
	'nes-apu': (o) => new NesApu(o),
	sid: (o) => new Sid(o),
	opl2: (o) => new Opl({ ...o, variant: 'opl2' }),
	opl3: (o) => new Opl({ ...o, variant: 'opl3' }),
	ym2612: (o) => new Ym2612(o),
	ym2151: (o) => new Ym2151(o),
	tandy: (o) => new Sn76489({ ...o, variant: 'ti', clock: o.clock ?? 3_579_545 }),
	'pc-speaker': (o) => new PcSpeaker(o),
	saa1099: (o) => new Saa1099(o),
	'pcm-dac': (o) => new PcmDac(o),
	ym2203: (o) => new Opn({ ...o, variant: 'ym2203' }),
	ym2608: (o) => new Opn({ ...o, variant: 'ym2608' }),
	'apple2-speaker': (o) => new AppleSpeaker(o),
	mockingboard: (o) => new Mockingboard(o),
	additive: (o) => new AdditiveSynth(o),
	vl1: (o) => new Vl1(o),
	synclavier: (o) => new Synclavier(o),
	'la-synth': (o) => new LaSynth(o),
	'ai-synth': (o) => new AiSynth(o),
	dx7: (o) => new Dx7Synth(o),
	gs1: (o) => new Gs1(o),
	d50: (o) => new D50Synth(o),
	m1: (o) => new M1Synth(o),
	microkorg: (o) => new MicroKorgSynth(o),
	namco163: (o) => new Namco163(o),
	fds: (o) => new Fds(o),
	vrc6: (o) => new Vrc6(o),
	sunsoft5b: (o) => new Sunsoft5b(o),
	mmc5: (o) => new Mmc5(o),
	cms: (o) => new CmsCard(o),
	'sound-blaster': (o) => new SoundBlasterCard(o),
};

/** create a chip by id; throws for an unknown id */
export function createChip(id: string, options: ChipOptions & Record<string, unknown> = {}): Chip {
	const factory = factories.get(id) ?? (Object.hasOwn(builtins, id) ? builtins[id] : undefined);
	if (!factory) throw new Error(`unknown chip '${id}' (known: ${chipIds().join(', ')})`);
	return factory(options);
}

/** ids of all registered chips */
export function chipIds(): string[] {
	return [...new Set([...Object.keys(builtins), ...factories.keys()])];
}

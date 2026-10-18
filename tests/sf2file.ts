/** A writer of small SoundFont 2 files for the tests: nothing is read from a real bank, every sample is computed. */

export interface Sf2Sample {
	name: string;
	data: Int16Array;
	rate: number;
	rootKey: number;
	loopStart?: number;
	loopEnd?: number;
	correction?: number;
	/** 1 mono (default), 2 right, 4 left */
	type?: number;
}

/** generators as [operator, amount]; a key or velocity range is [lo, hi] given as `lo | (hi << 8)` */
export type Gens = [number, number][];

export interface Sf2Zone {
	gens?: Gens;
	keyRange?: [number, number];
	velRange?: [number, number];
	/** an instrument zone points to a sample, a preset zone to an instrument */
	target?: number;
}

export interface Sf2Spec {
	name?: string;
	version?: [number, number];
	samples: Sf2Sample[];
	instruments: { name: string; global?: Gens; zones: Sf2Zone[] }[];
	presets: { name: string; bank?: number; program?: number; global?: Gens; zones: Sf2Zone[] }[];
}

export const GEN = {
	startAddrsOffset: 0,
	endAddrsOffset: 1,
	startLoopAddrsOffset: 2,
	endLoopAddrsOffset: 3,
	initialFilterFc: 8,
	initialFilterQ: 9,
	pan: 17,
	delayVolEnv: 33,
	attackVolEnv: 34,
	holdVolEnv: 35,
	decayVolEnv: 36,
	sustainVolEnv: 37,
	releaseVolEnv: 38,
	instrument: 41,
	keyRange: 43,
	velRange: 44,
	initialAttenuation: 48,
	coarseTune: 51,
	fineTune: 52,
	sampleId: 53,
	sampleModes: 54,
	scaleTuning: 56,
	overridingRootKey: 58,
} as const;

const u16 = (value: number): number[] => [value & 255, (value >> 8) & 255];
const u32 = (value: number): number[] => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255];
const text = (value: string, length: number): number[] =>
	Array.from({ length }, (_, i) => (i < value.length ? value.charCodeAt(i) : 0));

function chunk(id: string, body: number[]): number[] {
	return [...text(id, 4), ...u32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
}

function list(type: string, chunks: number[][]): number[] {
	return chunk('LIST', [...text(type, 4), ...chunks.flat()]);
}

const generator = (oper: number, amount: number): number[] => [...u16(oper), ...u16(amount & 0xffff)];

function zoneGenerators(zone: Sf2Zone, targetOper: number): number[] {
	const gens: number[] = [];
	if (zone.keyRange) gens.push(...generator(GEN.keyRange, zone.keyRange[0] | (zone.keyRange[1] << 8)));
	if (zone.velRange) gens.push(...generator(GEN.velRange, zone.velRange[0] | (zone.velRange[1] << 8)));
	for (const [oper, amount] of zone.gens ?? []) gens.push(...generator(oper, amount));
	if (zone.target !== undefined) gens.push(...generator(targetOper, zone.target));
	return gens;
}

/** the bytes of a SoundFont file for the description */
export function buildSf2(spec: Sf2Spec): Uint8Array {
	const [major, minor] = spec.version ?? [2, 4];
	// samples, each followed by 46 zero points as the specification asks
	const points: number[] = [];
	const shdr: number[] = [];
	for (const sample of spec.samples) {
		const start = points.length;
		points.push(...sample.data, ...new Array(46).fill(0));
		shdr.push(
			...text(sample.name, 20),
			...u32(start),
			...u32(start + sample.data.length),
			...u32(start + (sample.loopStart ?? 0)),
			...u32(start + (sample.loopEnd ?? sample.data.length)),
			...u32(sample.rate),
			sample.rootKey,
			(sample.correction ?? 0) & 255,
			...u16(0),
			...u16(sample.type ?? 1),
		);
	}
	shdr.push(...text('EOS', 20), ...new Array(26).fill(0));
	const smpl: number[] = [];
	for (const point of points) smpl.push(...u16(point & 0xffff));

	// instruments
	const inst: number[] = [];
	const ibag: number[] = [];
	const igen: number[] = [];
	let bags = 0;
	let gens = 0;
	for (const instrument of spec.instruments) {
		inst.push(...text(instrument.name, 20), ...u16(bags));
		const zones: { gens: number[] }[] = [];
		if (instrument.global)
			zones.push({ gens: instrument.global.flatMap(([oper, amount]) => generator(oper, amount)) });
		for (const zone of instrument.zones) zones.push({ gens: zoneGenerators(zone, GEN.sampleId) });
		for (const zone of zones) {
			ibag.push(...u16(gens), ...u16(0));
			igen.push(...zone.gens);
			gens += zone.gens.length / 4;
			bags++;
		}
	}
	inst.push(...text('EOI', 20), ...u16(bags));
	ibag.push(...u16(gens), ...u16(0));
	igen.push(...generator(0, 0));

	// presets
	const phdr: number[] = [];
	const pbag: number[] = [];
	const pgen: number[] = [];
	bags = 0;
	gens = 0;
	spec.presets.forEach((preset, index) => {
		phdr.push(
			...text(preset.name, 20),
			...u16(preset.program ?? index),
			...u16(preset.bank ?? 0),
			...u16(bags),
			...u32(0),
			...u32(0),
			...u32(0),
		);
		const zones: { gens: number[] }[] = [];
		if (preset.global) zones.push({ gens: preset.global.flatMap(([oper, amount]) => generator(oper, amount)) });
		for (const zone of preset.zones) zones.push({ gens: zoneGenerators(zone, GEN.instrument) });
		for (const zone of zones) {
			pbag.push(...u16(gens), ...u16(0));
			pgen.push(...zone.gens);
			gens += zone.gens.length / 4;
			bags++;
		}
	});
	phdr.push(...text('EOP', 20), ...u16(0), ...u16(0), ...u16(bags), ...u32(0), ...u32(0), ...u32(0));
	pbag.push(...u16(gens), ...u16(0));
	pgen.push(...generator(0, 0));

	const info = list('INFO', [
		chunk('ifil', [...u16(major), ...u16(minor)]),
		chunk('isng', text('EMU8000', 8)),
		chunk('INAM', text(spec.name ?? 'Test bank', 12)),
	]);
	const sdta = list('sdta', [chunk('smpl', smpl)]);
	const pdta = list('pdta', [
		chunk('phdr', phdr),
		chunk('pbag', pbag),
		chunk('pmod', new Array(10).fill(0)),
		chunk('pgen', pgen),
		chunk('inst', inst),
		chunk('ibag', ibag),
		chunk('imod', new Array(10).fill(0)),
		chunk('igen', igen),
		chunk('shdr', shdr),
	]);
	const body = [...text('sfbk', 4), ...info, ...sdta, ...pdta];
	return Uint8Array.from([...text('RIFF', 4), ...u32(body.length), ...body]);
}

/** a sine sample: `period` points a cycle, `cycles` cycles long, full scale `amplitude` of 32767 */
export function sine(period: number, cycles: number, amplitude = 0.8): Int16Array {
	return Int16Array.from({ length: period * cycles }, (_, i) =>
		Math.round(Math.sin((2 * Math.PI * i) / period) * 32767 * amplitude),
	);
}

/**
 * SoundFont 2 banks (`.sf2`): a reader for the user's own files. No bank ships with this package and none is
 * needed: the user opens a file (or a folder of them) and the presets of the bank become playable instruments
 * (`instruments/soundfont.ts`, `chips/SoundFont.ts`).
 *
 * What is read: the RIFF structure (`INFO`, `sdta` with 16 bit PCM samples, `pdta` with the nine tables of
 * presets, instruments and samples), resolved into voices the way the SoundFont 2.04 specification describes: a
 * preset zone selects an instrument, an instrument zone selects a sample, generators set absolute values at the
 * instrument level and offsets at the preset level, global zones fill in what a zone leaves out, key and velocity
 * ranges choose the zones that play.
 *
 * What is used of it, the subset also listed in `CONFORMANCE.md`: key and velocity ranges, sample choice, sample start
 * and end offsets, loop offsets and the loop mode, root key, coarse and fine tuning and scale tuning, initial
 * attenuation, pan, the volume envelope (delay, attack, hold, decay, sustain, release) and a fixed low-pass filter
 * (cut-off and resonance). Modulators are parsed but only the default ones of the specification are modelled by the
 * synthesizer (velocity to attenuation, and the channel volume, pan and pitch bend of the instrument controls); the
 * modulation envelope, the LFOs, the effects sends, key number to envelope timings and exclusive classes are ignored.
 *
 * What is refused: SF3 (samples compressed with Ogg Vorbis, which this package cannot decode yet) and SF2 files whose
 * samples are 24 bit only; both throw a `SoundFontError` that says so. Every offset and size read from the file is
 * checked against the file: a damaged bank is an error, never an endless loop or a read outside the data.
 */

export class SoundFontError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SoundFontError';
	}
}

export interface SfSample {
	name: string;
	/** first, last (exclusive), loop start and loop end positions in the sample data, in sample points */
	start: number;
	end: number;
	loopStart: number;
	loopEnd: number;
	sampleRate: number;
	/** MIDI key of the pitch the sample was recorded at (255 = unpitched, played as 60) */
	originalPitch: number;
	/** correction in cents */
	pitchCorrection: number;
	/** 1 mono, 2 right, 4 left (the ROM variants, +0x8000, are refused earlier) */
	type: number;
}

export interface SfPreset {
	name: string;
	bank: number;
	program: number;
}

/** the generators this reader keeps, by the number the specification gives them */
const enum Gen {
	StartAddrsOffset = 0,
	EndAddrsOffset = 1,
	StartLoopAddrsOffset = 2,
	EndLoopAddrsOffset = 3,
	StartAddrsCoarse = 4,
	InitialFilterFc = 8,
	InitialFilterQ = 9,
	EndAddrsCoarse = 12,
	Pan = 17,
	DelayVolEnv = 33,
	AttackVolEnv = 34,
	HoldVolEnv = 35,
	DecayVolEnv = 36,
	SustainVolEnv = 37,
	ReleaseVolEnv = 38,
	Instrument = 41,
	KeyRange = 43,
	VelRange = 44,
	StartLoopAddrsCoarse = 45,
	InitialAttenuation = 48,
	EndLoopAddrsCoarse = 50,
	CoarseTune = 51,
	FineTune = 52,
	SampleId = 53,
	SampleModes = 54,
	ScaleTuning = 56,
	OverridingRootKey = 58,
}

/** generators that are offsets at the preset level too, and so add to the instrument value */
const ADDITIVE = new Set<number>([
	Gen.StartAddrsOffset,
	Gen.EndAddrsOffset,
	Gen.StartLoopAddrsOffset,
	Gen.EndLoopAddrsOffset,
	Gen.StartAddrsCoarse,
	Gen.InitialFilterFc,
	Gen.InitialFilterQ,
	Gen.EndAddrsCoarse,
	Gen.Pan,
	Gen.DelayVolEnv,
	Gen.AttackVolEnv,
	Gen.HoldVolEnv,
	Gen.DecayVolEnv,
	Gen.SustainVolEnv,
	Gen.ReleaseVolEnv,
	Gen.StartLoopAddrsCoarse,
	Gen.InitialAttenuation,
	Gen.EndLoopAddrsCoarse,
	Gen.CoarseTune,
	Gen.FineTune,
	Gen.ScaleTuning,
]);

/** the value a generator has when no zone sets it (specification, section 8.1.2) */
const DEFAULTS: Readonly<Record<number, number>> = {
	[Gen.InitialFilterFc]: 13500,
	[Gen.DelayVolEnv]: -12000,
	[Gen.AttackVolEnv]: -12000,
	[Gen.HoldVolEnv]: -12000,
	[Gen.DecayVolEnv]: -12000,
	[Gen.ReleaseVolEnv]: -12000,
	[Gen.ScaleTuning]: 100,
	[Gen.OverridingRootKey]: -1,
};

type Generators = Map<number, number>;

interface Zone {
	generators: Generators;
	keyLo: number;
	keyHi: number;
	velLo: number;
	velHi: number;
}

interface Bag {
	generator: number;
	modulator: number;
}

/** a sounding voice, every value of it resolved and in plain units */
export interface SfVoice {
	sample: SfSample;
	/** offsets into the sample data, in points: where playing starts, where it stops, the loop */
	start: number;
	end: number;
	loopStart: number;
	loopEnd: number;
	/** none, continuous, or until the key is released */
	loopMode: 'none' | 'loop' | 'release';
	rootKey: number;
	/** cents on top of the key, and how many cents a key is worth */
	tuneCents: number;
	scaleTuning: number;
	/** dB of attenuation, and pan from -0.5 (left) to 0.5 (right) */
	attenuationDb: number;
	pan: number;
	/** volume envelope times in seconds and sustain as a gain */
	delay: number;
	attack: number;
	hold: number;
	decay: number;
	sustain: number;
	release: number;
	/** low-pass cut-off in Hz (above 19 kHz it is open) and resonance in dB */
	cutoffHz: number;
	resonanceDb: number;
}

export interface SoundFont {
	name: string;
	/** the version the file declares: 2.01 to 2.04 */
	version: string;
	presets: SfPreset[];
	samples: SfSample[];
	/** the 16 bit sample data as floats in -1..1 */
	data: Float32Array;
	/** the voices a note of a preset sounds: one per matching zone (a stereo sample is two zones) */
	voices(presetIndex: number, key: number, velocity: number): SfVoice[];
}

const MAX_ZONES_PER_NOTE = 32;
const timecents = (value: number): number => 2 ** (Math.max(-12000, Math.min(8000, value)) / 1200);
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

interface Chunk {
	id: string;
	start: number;
	size: number;
	/** for a LIST, its type */
	type?: string;
}

function readChunks(view: DataView, start: number, end: number): Chunk[] {
	const chunks: Chunk[] = [];
	let at = start;
	while (at + 8 <= end) {
		const id = ascii(view, at, 4);
		const size = view.getUint32(at + 4, true);
		const body = at + 8;
		if (body + size > end) throw new SoundFontError(`truncated "${id}" chunk`);
		if (id === 'LIST' || id === 'RIFF') {
			if (size < 4) throw new SoundFontError('a LIST chunk without a type');
			chunks.push({ id, start: body + 4, size: size - 4, type: ascii(view, body, 4) });
		} else chunks.push({ id, start: body, size });
		at = body + size + (size & 1);
	}
	return chunks;
}

function ascii(view: DataView, at: number, length: number): string {
	let text = '';
	for (let i = 0; i < length && at + i < view.byteLength; i++) {
		const code = view.getUint8(at + i);
		if (code === 0) break;
		text += String.fromCharCode(code);
	}
	return text;
}

/** read a SoundFont 2 file; throws `SoundFontError` for a damaged file and for SF3 */
export function parseSf2(file: Uint8Array): SoundFont {
	if (file.length < 12) throw new SoundFontError('not a SoundFont file (too short)');
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'sfbk') throw new SoundFontError('not a SoundFont file');
	const riffSize = view.getUint32(4, true);
	const end = Math.min(file.length, 8 + riffSize);
	const top = readChunks(view, 12, end);
	const find = (type: string): Chunk => {
		const found = top.find((chunk) => chunk.id === 'LIST' && chunk.type === type);
		if (!found) throw new SoundFontError(`no ${type} section`);
		return found;
	};
	const info = readChunks(view, find('INFO').start, find('INFO').start + find('INFO').size);
	const sdta = readChunks(view, find('sdta').start, find('sdta').start + find('sdta').size);
	const pdta = readChunks(view, find('pdta').start, find('pdta').start + find('pdta').size);

	const ifil = info.find((chunk) => chunk.id === 'ifil');
	if (!ifil || ifil.size < 4) throw new SoundFontError('no version in the file');
	const major = view.getUint16(ifil.start, true);
	const minor = view.getUint16(ifil.start + 2, true);
	if (major >= 3)
		throw new SoundFontError(
			`SoundFont ${major}.${minor} (SF3) keeps its samples as Ogg Vorbis, which this package cannot decode yet: open an SF2 file`,
		);
	if (major !== 2) throw new SoundFontError(`unsupported SoundFont version ${major}.${minor}`);
	const nameChunk = info.find((chunk) => chunk.id === 'INAM');
	const name = nameChunk ? ascii(view, nameChunk.start, Math.min(nameChunk.size, 256)) : 'SoundFont';

	const smpl = sdta.find((chunk) => chunk.id === 'smpl');
	if (!smpl) throw new SoundFontError('no 16 bit sample data (the bank has 24 bit samples only, or none)');
	const points = Math.floor(smpl.size / 2);
	const data = new Float32Array(points);
	for (let i = 0; i < points; i++) data[i] = view.getInt16(smpl.start + i * 2, true) / 32768;

	const table = (id: string, record: number): Chunk => {
		const chunk = pdta.find((candidate) => candidate.id === id);
		if (!chunk || chunk.size % record !== 0 || chunk.size < record)
			throw new SoundFontError(`missing or damaged "${id}" table`);
		return chunk;
	};
	const count = (chunk: Chunk, record: number): number => chunk.size / record;

	// samples
	const shdr = table('shdr', 46);
	const samples: SfSample[] = [];
	for (let i = 0; i < count(shdr, 46) - 1; i++) {
		const at = shdr.start + i * 46;
		const type = view.getUint16(at + 44, true);
		const sample: SfSample = {
			name: ascii(view, at, 20),
			start: view.getUint32(at + 20, true),
			end: view.getUint32(at + 24, true),
			loopStart: view.getUint32(at + 28, true),
			loopEnd: view.getUint32(at + 32, true),
			sampleRate: view.getUint32(at + 36, true),
			originalPitch: view.getUint8(at + 40),
			pitchCorrection: view.getInt8(at + 41),
			type,
		};
		if (type & 0x8000 || type & 0x10)
			throw new SoundFontError(`sample "${sample.name}" is ROM or Ogg compressed: not supported`);
		samples.push(sample);
	}

	// generator and bag tables
	const readGenerators = (chunk: Chunk): { oper: number; amount: number; raw: number }[] => {
		const generators: { oper: number; amount: number; raw: number }[] = [];
		for (let i = 0; i < count(chunk, 4); i++) {
			const at = chunk.start + i * 4;
			generators.push({
				oper: view.getUint16(at, true),
				amount: view.getInt16(at + 2, true),
				raw: view.getUint16(at + 2, true),
			});
		}
		return generators;
	};
	const readBags = (chunk: Chunk): Bag[] => {
		const bags: Bag[] = [];
		for (let i = 0; i < count(chunk, 4); i++)
			bags.push({
				generator: view.getUint16(chunk.start + i * 4, true),
				modulator: view.getUint16(chunk.start + i * 4 + 2, true),
			});
		return bags;
	};
	const pgen = readGenerators(table('pgen', 4));
	const igen = readGenerators(table('igen', 4));
	const pbag = readBags(table('pbag', 4));
	const ibag = readBags(table('ibag', 4));
	// the modulator tables are checked for their size and otherwise not used, see the header
	table('pmod', 10);
	table('imod', 10);

	/** the zones of the records `from` to `to` (exclusive) of a bag table, the global zone first when there is one */
	const zonesOf = (
		bags: Bag[],
		generators: { oper: number; amount: number; raw: number }[],
		from: number,
		to: number,
		terminal: number,
	): { global: Zone | null; zones: Zone[] } => {
		const zones: Zone[] = [];
		let global: Zone | null = null;
		for (let bag = from; bag < to; bag++) {
			const first = bags[bag]?.generator;
			const last = bags[bag + 1]?.generator;
			if (first === undefined || last === undefined || first > last || last > generators.length)
				throw new SoundFontError('a zone points outside the generator table');
			const zone: Zone = { generators: new Map(), keyLo: 0, keyHi: 127, velLo: 0, velHi: 127 };
			for (let g = first; g < last; g++) {
				const { oper, amount, raw } = generators[g];
				if (oper === Gen.KeyRange) {
					zone.keyLo = raw & 255;
					zone.keyHi = raw >> 8;
				} else if (oper === Gen.VelRange) {
					zone.velLo = raw & 255;
					zone.velHi = raw >> 8;
				} else zone.generators.set(oper, oper === Gen.Instrument || oper === Gen.SampleId ? raw : amount);
			}
			if (bag === from && !zone.generators.has(terminal)) global = zone;
			else if (zone.generators.has(terminal)) zones.push(zone);
		}
		return { global, zones };
	};

	// instruments
	const inst = table('inst', 22);
	const instruments: { global: Zone | null; zones: Zone[] }[] = [];
	for (let i = 0; i < count(inst, 22) - 1; i++) {
		const from = view.getUint16(inst.start + i * 22 + 20, true);
		const to = view.getUint16(inst.start + (i + 1) * 22 + 20, true);
		if (from > to || to >= ibag.length + 1) throw new SoundFontError('an instrument points outside the zone table');
		instruments.push(zonesOf(ibag, igen, from, to, Gen.SampleId));
	}

	// presets
	const phdr = table('phdr', 38);
	const presets: SfPreset[] = [];
	const presetZones: { global: Zone | null; zones: Zone[] }[] = [];
	for (let i = 0; i < count(phdr, 38) - 1; i++) {
		const at = phdr.start + i * 38;
		const from = view.getUint16(at + 24, true);
		const to = view.getUint16(phdr.start + (i + 1) * 38 + 24, true);
		if (from > to || to >= pbag.length + 1) throw new SoundFontError('a preset points outside the zone table');
		presets.push({
			name: ascii(view, at, 20),
			program: view.getUint16(at + 20, true),
			bank: view.getUint16(at + 22, true),
		});
		presetZones.push(zonesOf(pbag, pgen, from, to, Gen.Instrument));
	}

	const inRange = (zone: Zone, key: number, velocity: number): boolean =>
		key >= zone.keyLo && key <= zone.keyHi && velocity >= zone.velLo && velocity <= zone.velHi;

	function voices(presetIndex: number, key: number, velocity: number): SfVoice[] {
		const preset = presetZones[presetIndex];
		const found: SfVoice[] = [];
		if (!preset) return found;
		for (const presetZone of preset.zones) {
			if (!inRange(presetZone, key, velocity)) continue;
			const instrument = instruments[presetZone.generators.get(Gen.Instrument) ?? -1];
			if (!instrument) continue;
			for (const zone of instrument.zones) {
				if (!inRange(zone, key, velocity)) continue;
				const sample = samples[zone.generators.get(Gen.SampleId) ?? -1];
				if (!sample) continue;
				const value = (gen: number): number => {
					const base =
						zone.generators.get(gen) ?? instrument.global?.generators.get(gen) ?? DEFAULTS[gen] ?? 0;
					if (!ADDITIVE.has(gen)) return base;
					return base + (presetZone.generators.get(gen) ?? preset.global?.generators.get(gen) ?? 0);
				};
				found.push(makeVoice(sample, value, data.length));
				if (found.length >= MAX_ZONES_PER_NOTE) return found;
			}
		}
		return found;
	}

	return { name, version: `${major}.${minor}`, presets, samples, data, voices };
}

function makeVoice(sample: SfSample, value: (gen: number) => number, dataLength: number): SfVoice {
	const point = (base: number, fine: number, coarse: number): number => base + value(fine) + 32768 * value(coarse);
	const start = clamp(point(sample.start, Gen.StartAddrsOffset, Gen.StartAddrsCoarse), 0, dataLength);
	const end = clamp(point(sample.end, Gen.EndAddrsOffset, Gen.EndAddrsCoarse), start, dataLength);
	const loopStart = clamp(point(sample.loopStart, Gen.StartLoopAddrsOffset, Gen.StartLoopAddrsCoarse), start, end);
	const loopEnd = clamp(point(sample.loopEnd, Gen.EndLoopAddrsOffset, Gen.EndLoopAddrsCoarse), loopStart, end);
	const modes = value(Gen.SampleModes) & 3;
	const root = value(Gen.OverridingRootKey);
	const sustainCb = clamp(value(Gen.SustainVolEnv), 0, 1440);
	const fc = clamp(value(Gen.InitialFilterFc), 1500, 13500);
	return {
		sample,
		start,
		end,
		loopStart,
		loopEnd,
		// a loop of fewer than two points cannot be played: such a sample plays once
		loopMode: loopEnd - loopStart < 2 ? 'none' : modes === 1 ? 'loop' : modes === 3 ? 'release' : 'none',
		rootKey: root >= 0 && root <= 127 ? root : sample.originalPitch <= 127 ? sample.originalPitch : 60,
		tuneCents: value(Gen.CoarseTune) * 100 + value(Gen.FineTune) + sample.pitchCorrection,
		scaleTuning: value(Gen.ScaleTuning),
		attenuationDb: clamp(value(Gen.InitialAttenuation), 0, 1440) / 10,
		pan: clamp(value(Gen.Pan), -500, 500) / 1000,
		delay: timecents(value(Gen.DelayVolEnv)),
		attack: timecents(value(Gen.AttackVolEnv)),
		hold: timecents(value(Gen.HoldVolEnv)),
		decay: timecents(value(Gen.DecayVolEnv)),
		sustain: 10 ** (-sustainCb / 200),
		release: timecents(value(Gen.ReleaseVolEnv)),
		cutoffHz: 8.176 * 2 ** (fc / 1200),
		resonanceDb: clamp(value(Gen.InitialFilterQ), 0, 960) / 10,
	};
}

/** true for a file that starts like a SoundFont (any version): the check a file picker can make before a full read */
export function isSoundFont(bytes: Uint8Array): boolean {
	return (
		bytes.length > 12 &&
		String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
		String.fromCharCode(...bytes.subarray(8, 12)) === 'sfbk'
	);
}

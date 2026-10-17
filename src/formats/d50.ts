import { D50_WAVE_ATTACKS, D50_WAVE_LOOPS } from '../chips/d50Waves.ts';
import { type BreakPoints, type D50Lfo, type D50Partial, type D50Patch, type D50Tone } from '../chips/historical.ts';

/**
 * Roland D-50 / D-550 / D-05 patch SysEx, read into `D50Patch` for the ROM-free `D50Synth`.
 *
 * The message layout and the parameter map are those of Roland's "D-05 MIDI Implementation" (the D-05 shares the
 * D-50's data format): `F0 41 dev 14 cmd a1 a2 a3 data... checksum F7`, with cmd `12` (DT1, one-way) or `42` (DAT,
 * handshake), a 3 byte address in **7 bit units** and a checksum that makes address + data + checksum a multiple of
 * 128. A patch is seven blocks of 64 bytes (upper partial 1, 2, common, lower partial 1, 2, common, patch), found
 * either in the temporary area (address 0) or in patch memory 1-1 .. 8-8 (from `02 00 00`, 448 bytes each).
 *
 * What is converted: structure (and with it which partials are synthesised or PCM), pitch (coarse and fine), waveform,
 * pulse width, the TVF (cut-off, resonance, 5 stage envelope and its depth), the TVA (level and 5 stage envelope),
 * LFO-1, the partial balance and mute, the tone balance, the pitch and filter key follow, the pitch envelope, the
 * partial LFO mode, the chorus and reverb levels. **Approximations**: only the end points of the time, LFO and chorus
 * laws are published (see `expLaw`), the curves between them and the cut-off and level laws are choices, not
 * measurements; PCM waves 1-47 (the attacks) and
 * 48-76 (looped sounds, Spectrum, Noise) play the profiles fitted on the ROM (`d50Waves.ts`), 77-100 (combinations of
 * 1-76, whose pairing is in the absent control ROM) play a sawtooth; the velocity sensitivities, bias, LFO-2/3 on
 * the filter and amplifier, the end level of the envelopes and the EQ are read but not used.
 */

export const MODEL_D50 = 0x14;
const DT1 = 0x12;
const DAT = 0x42;

const BLOCK = 64;
const PATCH_SIZE = 7 * BLOCK;
const PATCH_MEMORY_BASE = 2 << 14;
const KEY_MODES = ['Whole', 'Dual', 'Split', 'Separate', 'Whole-S', 'Dual-S', 'Split-US', 'Split-LS', 'Separate-S'];
const NAME_CHARS = ` ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890-`;

export interface D50SysExPatch {
	/** patch name (18 characters in the patch block) or the upper tone name when the dump has no patch block */
	name: string;
	toneNames: string[];
	keyMode: string;
	/** where it came from: `temporary` or `memory` (then `slot` is 1..64: bank 1-1 is 1, 8-8 is 64) */
	source: 'temporary' | 'memory';
	slot?: number;
	patch: D50Patch;
}

/** the 7 bit address of a message: `02 03 40` is 2 * 16384 + 3 * 128 + 64 */
const address7 = (a: number, b: number, c: number): number => (a << 14) | (b << 7) | c;

/** Parse every valid D-50 DT1 / DAT message of a byte stream (a `.syx` file) into a flat address -> byte memory */
export function readD50Memory(bytes: Uint8Array): Map<number, number> {
	const memory = new Map<number, number>();
	let i = 0;
	while (i < bytes.length) {
		if (bytes[i] !== 0xf0) {
			i++;
			continue;
		}
		let end = i + 1;
		while (end < bytes.length && bytes[end] !== 0xf7) end++;
		const m = bytes.subarray(i, end + 1);
		i = end + 1;
		// F0 41 dev 14 cmd a a a data... checksum F7
		if (m.length < 10 || m[m.length - 1] !== 0xf7 || m[1] !== 0x41 || m[3] !== MODEL_D50) continue;
		if (m[4] !== DT1 && m[4] !== DAT) continue;
		let sum = 0;
		for (let k = 5; k < m.length - 1; k++) sum += m[k];
		if (sum % 128 !== 0) continue;
		const base = address7(m[5], m[6], m[7]);
		for (let k = 8; k < m.length - 2; k++) memory.set(base + k - 8, m[k]);
	}
	return memory;
}

/** Build a DT1 message of the D-50 (for tests and for sending a patch back to a real unit) */
export function buildD50Dt1(device: number, address: number, data: ArrayLike<number>): Uint8Array {
	const body = [(address >> 14) & 0x7f, (address >> 7) & 0x7f, address & 0x7f, ...Array.from(data)];
	const sum = body.reduce((s, v) => s + v, 0);
	return Uint8Array.from([0xf0, 0x41, device, MODEL_D50, DT1, ...body, (128 - (sum % 128)) % 128, 0xf7]);
}

/**
 * The end points of these laws are published (D-50 Service Notes, specifications, p. 1); the curve between them is
 * not, so each law is the exponential through its two end points (a choice, not a measurement).
 *   TVF / TVA T1-T5 (0-100): 4 ms - 80 s      pitch envelope T1-T4 (0-50): 9 ms - 9 s
 *   LFO rate (0-100): 0.0004 - 27 Hz           LFO delay (0-100): 0 - 10 s          chorus rate (0-100): 0.098 - 20 Hz
 *   LFO pitch depth: +-600 cents               pitch envelope: +-2400 cents (the 50 steps span 1, 1.5 or 2 octaves)
 * The cut-off frequency and the level laws are not published at all: smooth guesses.
 */
const expLaw = (v: number, max: number, lo: number, hi: number): number => lo * (hi / lo) ** (v / max);
const envTime = (t: number): number => expLaw(t, 100, 0.004, 80);
const pitchEnvTime = (t: number): number => expLaw(t, 50, 0.009, 9);
const lfoRateHz = (v: number): number => expLaw(v, 100, 0.0004, 27);
const lfoDelaySeconds = (v: number): number => 10 * (v / 100) ** 2;
const chorusRateHz = (v: number): number => expLaw(v, 100, 0.098, 20);
const envLevel = (v: number): number => (v / 100) ** 2;
const cutoffHz = (v: number): number => 40 * 2 ** ((v / 100) * 9);

/** key follow of the pitch (index 0-16) and of the TVF (0-14): -1, -1/2, -1/4, 0, 1/8 ... 7/8, 1, 5/4, 3/2, 2, then s1 / s2 (Set-Ups p. 14) */
const KEY_FOLLOW = [
	-1,
	-0.5,
	-0.25,
	0,
	0.125,
	0.25,
	0.375,
	0.5,
	0.625,
	0.75,
	0.875,
	1,
	1.25,
	1.5,
	2,
	1 + 1 / 1200,
	1 + 5 / 1200,
];

const name = (read: (o: number) => number, from: number, length: number): string =>
	Array.from({ length }, (_, k) => NAME_CHARS[read(from + k) & 63])
		.join('')
		.trimEnd();

/** the common block (offsets as in the Common Parameter table) */
function commonOf(read: (o: number) => number): {
	name: string;
	structure: number;
	lfo: D50Lfo | undefined;
	chorus: D50Patch['chorus'];
	mute: number;
	balance: number;
	/** pitch envelope break points in octaves (+ polarity): [time, octaves] */
	penv: [number, number][];
} {
	const lfoDepth = read(0x16);
	const pitchLfo = lfoDepth > 0;
	const lfo: D50Lfo = { rate: lfoRateHz(read(0x1a)), delay: lfoDelaySeconds(read(0x1b)) };
	if (pitchLfo) lfo.pitchCents = (lfoDepth / 100) * 600;
	// pitch envelope: T1-T3 and the levels L0, L1, L2, sustain (T4 and the end level apply after the key is released)
	const octaveSpan = 1 + 0.5 * Math.min(2, read(0x0b));
	const penvTimes = [0x0d, 0x0e, 0x0f].map((o) => pitchEnvTime(Math.min(50, read(o))));
	const penvOctaves = [0x11, 0x12, 0x13, 0x14].map((o) => ((read(o) - 50) / 50) * octaveSpan);
	const chorusBalance = read(0x2d);
	return {
		name: name(read, 0, 10),
		structure: Math.min(6, read(0x0a)) + 1,
		lfo: pitchLfo ? lfo : undefined,
		chorus:
			chorusBalance > 0
				? { mix: (chorusBalance / 100) * 0.6, rate: chorusRateHz(read(0x2b)), depth: read(0x2c) / 100 }
				: undefined,
		mute: read(0x2e) & 3,
		balance: read(0x2f),
		penv: [
			[0, penvOctaves[0]],
			[penvTimes[0], penvOctaves[1]],
			[penvTimes[0] + penvTimes[1], penvOctaves[2]],
			[penvTimes[0] + penvTimes[1] + penvTimes[2], penvOctaves[3]],
		],
	};
}

/** a 5 stage envelope: times T1..T5, levels L1..L3 and sustain, as break points up to the sustain (T5 is the release) */
function stages(times: number[], levels: number[], first: number, shape: (v: number) => number): BreakPoints {
	const points: [number, number][] = [[0, first]];
	let t = 0;
	for (let k = 0; k < 4; k++) {
		t += envTime(times[k]);
		points.push([t, shape(levels[k])]);
	}
	return points;
}

const ATTACKS = 47; // PCM waves 1-47 are the attacks of the D-50
const LOOPED = 29; // waves 48-76 are the looped sounds, 77-100 combinations of 1-76

/** names of the 100 PCM waves (Terry Fryer, "Synthesizer Set-Ups: Roland D-50", p. 15); 77-100 are combinations */
export const D50_PCM_NAMES: readonly string[] = [
	...['Marimba', 'Vibes', 'Xylophone 1', 'Xylophone 2', 'Log Bass', 'Hammer', 'Japanese Drum', 'Kalimba'],
	...['Pluck 1', 'Chink', 'Agogo', 'Triangle', 'Bells', 'Nail File', 'Pick', 'Low Piano'],
	...['Mid Piano', 'High Piano', 'Harpsichord', 'Harp', 'Organ Percussion', 'Steel String', 'Nylon String'],
	...['Elec. Guitar 1', 'Elec. Guitar 2', 'Dirty Guitar', 'Pick Bass', 'Pop Bass', 'Thumb Bass', 'Upright Bass'],
	...['Clarinet', 'Breath', 'Steam', 'High Flute', 'Low Flute', 'Guiro', 'Indian Flute', 'Flute Harmonic'],
	...['Lips 1', 'Lips 2', 'Trumpet', 'Trombone', 'Contrabass', 'Cello', 'Violin Bow', 'Violins', 'Pizzicato'],
	...['Drawbar Organ', 'High Organ', 'Low Organ', 'Elec. Piano 1', 'Elec. Piano 2', 'Clav', 'Harpsichord'],
	...['Elec. Bass 1', 'Acoustic Bass', 'Elec. Bass 2', 'Elec. Bass 3', 'Elec. Guitar', 'Cello', 'Violin'],
	...['Reed', 'Sax 1', 'Sax 2', 'Aah', 'Ooh', 'Male 1'],
	...Array.from({ length: 7 }, (_, i) => `Spectrum ${i + 1}`),
	...['Male 2', 'Noise'],
	...Array.from({ length: 24 }, (_, i) => `Loop ${i + 1}`),
];

/**
 * How a PCM wave number (0-99 as stored) is played. The ROM dump gives, in the order of the wave list: the 47 attacks
 * (pages 0-91, a fitted recipe each), the exactly repeating loops 48-67, Spectrum 1-7 and Male 2 (one page each, a
 * harmonic profile) and Noise (white noise). Waves 77-100 are combinations of 1-76 whose pairing is in the control
 * ROM (absent): a sawtooth stands in for them.
 */
function pcmOf(wave: number): Pick<D50Partial, 'wave' | 'recipe' | 'loop'> {
	if (wave < ATTACKS) return { wave: 'attack', recipe: D50_WAVE_ATTACKS[wave] };
	if (wave >= ATTACKS + LOOPED) return { wave: 'saw' };
	const lines = D50_WAVE_LOOPS[wave - ATTACKS];
	if (!lines) return { wave: 'noise' };
	const h = new Array<number>(Math.max(...lines.map(([k]) => k))).fill(0);
	for (const [k, amp] of lines) h[k - 1] = amp;
	return { wave: 'loop', loop: h };
}

function partialOf(
	read: (o: number) => number,
	kind: 'synth' | 'pcm',
	gain: number,
	lfo: boolean,
	penv: [number, number][],
): D50Partial {
	const tvfTimes = [0x16, 0x17, 0x18, 0x19].map(read);
	const tvfLevels = [0x1b, 0x1c, 0x1d, 0x1e].map(read);
	const tvaTimes = [0x27, 0x28, 0x29, 0x2a].map(read);
	const tvaLevels = [0x2c, 0x2d, 0x2e, 0x2f].map(read);
	const depthOctaves = (read(0x12) / 100) * 6;
	const base = cutoffHz(read(0x0d));
	const semitones = read(0x00) - 36 + (read(0x01) - 50) / 100; // standard pitch is the pitch at C4
	const wave = read(0x07); // PCM wave 1-100, stored 0-99
	const lfoSelect = (o: number): number => (read(o) >> 1) + 1; // 0..5 = +1, -1, +2, -2, +3, -3 -> LFO number
	const p: D50Partial = {
		wave: 'saw',
		cutoff: base * 2 ** depthOctaves,
		resonance: Math.min(1, (read(0x0e) / 30) * 0.9),
		filterDepth: depthOctaves,
		filterEnv: stages(tvfTimes, tvfLevels, 0, (v) => v / 100),
		amp: stages(tvaTimes, tvaLevels, 0, envLevel),
		level: envLevel(read(0x23)) * gain,
		detuneCents: semitones * 100,
	};
	const kf = KEY_FOLLOW[Math.min(16, read(0x02))];
	if (kf !== 1) p.keyFollow = kf;
	const fkf = KEY_FOLLOW[Math.min(14, read(0x0f))];
	if (fkf !== 0) p.filterKeyFollow = fkf;
	p.lfoSign = [0, 1, -1, 0][read(0x03) & 3]; // Off, (+), (-), A&L (only with aftertouch or the lever: none here)
	const penvMode = read(0x04); // Off, (+), (-)
	if (penvMode === 1 || penvMode === 2) {
		const sign = penvMode === 1 ? 1 : -1;
		const points = penv.map(([t, o]) => [t, 2 ** (sign * o)] as [number, number]);
		if (points.some(([, m]) => Math.abs(Math.log2(m)) > 0.01)) p.pitchEnv = points;
	}
	if (kind === 'pcm') {
		Object.assign(p, pcmOf(wave));
		if (p.wave === 'saw') {
			// stand-in for a combination wave (77-100): a fixed soft filter, as the real PCM is not filtered either
			p.cutoff = 3000;
			p.filterDepth = 0;
			delete p.filterKeyFollow;
		} else p.bypassFilter = true; // the TVF applies to synthesised partials only (Creative Book, table 4)
	} else if (read(0x06) === 0) {
		p.wave = 'square';
		p.pulseWidth = 0.5 - (read(0x08) / 100) * 0.45;
		if (lfo && lfoSelect(0x0a) === 1 && read(0x0b) > 0) {
			p.pwmDepth = (read(0x0b) / 100) * 0.3;
			p.pwmRate = 0.5;
		}
	}
	return p;
}

/** release time of a tone: the longest TVA T5 (offset 0x2b) of its partials, bounded */
const releaseOf = (reads: ((o: number) => number)[]): number =>
	Math.min(4, Math.max(0.05, ...reads.map((r) => envTime(r(0x2b)))));

/** Read the patches of a stream of D-50 SysEx messages (a `.syx` file): temporary area and patch memory slots */
export function parseD50SysEx(bytes: Uint8Array): D50SysExPatch[] {
	const memory = readD50Memory(bytes);
	const have = (base: number, from: number, to: number): boolean => {
		for (let o = from; o <= to; o++) if (!memory.has(base + o)) return false;
		return true;
	};
	const reader = (base: number) => (o: number) => memory.get(base + o) ?? 0;
	const out: D50SysExPatch[] = [];

	const bases: { base: number; source: D50SysExPatch['source']; slot?: number }[] = [
		{ base: 0, source: 'temporary' },
	];
	for (let s = 0; s < 64; s++)
		bases.push({ base: PATCH_MEMORY_BASE + s * PATCH_SIZE, source: 'memory', slot: s + 1 });

	for (const { base, source, slot } of bases) {
		// tone t (0 upper, 1 lower) = blocks [partial 1, partial 2, common] at base + t * 3 * BLOCK
		const tones: { index: number; common: ReturnType<typeof commonOf>; partials: ((o: number) => number)[] }[] = [];
		for (let t = 0; t < 2; t++) {
			const tb = base + t * 3 * BLOCK;
			if (!have(tb, 0, 0x35) || !have(tb + BLOCK, 0, 0x35) || !have(tb + 2 * BLOCK, 0, 0x2f)) continue;
			tones.push({
				index: t,
				common: commonOf(reader(tb + 2 * BLOCK)),
				partials: [reader(tb), reader(tb + BLOCK)],
			});
		}
		if (tones.length === 0 && !have(base + 6 * BLOCK, 0, 0x27)) continue;
		const pb = base + 6 * BLOCK;
		const hasPatch = have(pb, 0, 0x27);
		const pr = reader(pb);
		const keyMode = hasPatch ? (KEY_MODES[pr(0x12)] ?? 'Whole') : 'Whole';
		const toneBalance = hasPatch ? pr(0x21) / 100 : 0.5;
		const layered = keyMode === 'Dual' || keyMode === 'Dual-S';
		const used = layered || tones.length < 2 ? tones : tones.slice(0, 1);
		if (used.length === 0) continue;

		const dTones: D50Tone[] = used.map((tone) => {
			const c = tone.common;
			const kinds: ('synth' | 'pcm')[][] = [
				['synth', 'synth'],
				['synth', 'synth'],
				['pcm', 'synth'],
				['pcm', 'synth'],
				['synth', 'pcm'],
				['pcm', 'pcm'],
				['pcm', 'pcm'],
			];
			const k = kinds[c.structure - 1];
			// partial balance: the documents do not give its direction; by analogy with the tone balance, 100 = partial 1
			const b = c.balance / 100;
			const gains = [Math.min(1, 2 * b), Math.min(1, 2 * (1 - b))];
			// tone balance: 0 = only the lower tone, 100 = only the upper tone (Set-Ups, p. 5)
			const toneGain = layered
				? tone.index === 0
					? Math.min(1, 2 * toneBalance)
					: Math.min(1, 2 * (1 - toneBalance))
				: 1;
			// tone key shift (+-24 semitones) and tone fine tune (+-50 cents), patch block offsets 16h-19h
			const shift = hasPatch ? (pr(0x16 + tone.index) - 24) * 100 + (pr(0x18 + tone.index) - 50) : 0;
			const lfoUsed = c.lfo !== undefined;
			const t: D50Tone = {
				structure: c.structure,
				partials: tone.partials.map((r, pi) => {
					const p = partialOf(r, k[pi], gains[pi] * toneGain, lfoUsed, c.penv);
					if (!(c.mute & (1 << pi))) p.mute = true;
					if (shift) p.detuneCents = (p.detuneCents ?? 0) + shift;
					return p;
				}),
			};
			if (c.lfo) t.lfo = c.lfo;
			return t;
		});
		const patch: D50Patch = { tones: dTones, release: releaseOf(used.flatMap((u) => u.partials)) };
		const chorus = used[0].common.chorus;
		if (chorus) patch.chorus = chorus;
		const reverbBalance = hasPatch ? pr(0x1f) : 0;
		if (reverbBalance > 0) patch.reverb = { mix: (reverbBalance / 100) * 0.5, feedback: 0.5 };
		const toneNames = tones.map((t) => t.common.name);
		out.push({
			name: hasPatch ? name(pr, 0, 18) : (toneNames[0] ?? ''),
			toneNames,
			keyMode,
			source,
			slot,
			patch,
		});
	}
	return out;
}

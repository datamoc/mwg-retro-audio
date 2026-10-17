import type { MwaData } from '../formats/mwa.ts';
import type { SfxChip, SfxDefinition, SfxVoiceProgram } from './types.ts';

export interface ImportOptions {
	name: string;
	/** which chip of the file to read (default: the first of a supported family) */
	chipIndex?: number;
	/** ticks per second of the definition (default: the frame rate of the file) */
	tickRate?: number;
	priority?: number;
	retrigger?: SfxDefinition['retrigger'];
}

type Sampler = () => void;

interface Channel {
	rawPeriod: number[];
	rawVolume: number[];
	mix: number[];
	noise: number[];
	duty: number[];
	used: boolean;
	noiseUsed: boolean;
	dutyUsed: boolean;
	envelope?: { period: number; shape: number };
	waveform?: number;
	adsr?: [number, number, number, number];
}

const newChannel = (): Channel => ({
	rawPeriod: [],
	rawVolume: [],
	mix: [],
	noise: [],
	duty: [],
	used: false,
	noiseUsed: false,
	dutyUsed: false,
});

/** the family of effects a chip id belongs to, or null when no import is written for it */
function familyOf(id: string): SfxChip | null {
	switch (id) {
		case 'ym2149':
			return 'ym2149';
		case 'ay8910':
			return 'ay8910';
		case 'sn76489':
			return 'sn76489';
		case 'nes-apu':
			return 'nes';
		case 'sid':
			return 'sid';
		default:
			return null;
	}
}

/**
 * Turn a recording of register writes (an `MwaData`, from `MwaRecorder` or a converted file) into a sound effect
 * definition: the registers of every channel are sampled once per tick and become `rawPeriod` / `rawVolume` / `mix` /
 * `noisePeriod` / `duty` tables, so the effect replays what the original routine wrote. Channels that never make a
 * sound are left out and trailing silence is trimmed. Supported: YM2149 / AY, SN76489, NES APU, SID.
 */
export function importSfx(data: MwaData, options: ImportOptions): SfxDefinition {
	const idx = options.chipIndex ?? data.chips.findIndex((c) => familyOf(c.id) !== null);
	const spec = data.chips[idx];
	const family = spec ? familyOf(spec.id) : null;
	if (!spec || !family)
		throw new Error('importSfx: no chip of a supported family (YM2149, SN76489, NES APU, SID) in the recording');
	const tickRate = options.tickRate ?? data.frameRate;
	const ticks = Math.max(1, Math.ceil((data.length * tickRate) / data.timebase));
	const channelCount = family === 'nes' ? 4 : family === 'sn76489' ? 4 : 3;
	const channels = Array.from({ length: channelCount }, newChannel);
	const writes: { time: number; addr: number; value: number }[] = [];
	for (let i = 0; i < data.time.length; i++)
		if (data.chip[i] === idx) writes.push({ time: data.time[i], addr: data.addr[i], value: data.value[i] });

	const regs = new Uint8Array(256);
	// SN76489 byte protocol state
	const snTone = [0, 0, 0];
	const snAtt = [15, 15, 15, 15];
	let snNoise = 0;
	let latch = 0;
	let w = 0;
	const apply = (addr: number, value: number): void => {
		if (family !== 'sn76489') {
			regs[addr & 0xff] = value;
			return;
		}
		if (value & 0x80) latch = (value >> 4) & 7;
		const r = latch >> 1;
		if (latch & 1) snAtt[r] = value & 15;
		else if (r === 3) snNoise = value & 7;
		else snTone[r] = value & 0x80 ? (snTone[r] & 0x3f0) | (value & 15) : (snTone[r] & 15) | ((value & 0x3f) << 4);
	};

	const sample: Sampler = () => {
		if (family === 'ym2149' || family === 'ay8910') {
			for (let c = 0; c < 3; c++) {
				const ch = channels[c];
				const period = regs[c * 2] | ((regs[c * 2 + 1] & 15) << 8);
				const volReg = regs[8 + c];
				const env = (volReg & 0x10) !== 0;
				const vol = env ? 15 : volReg & 15;
				const mixer = regs[7];
				const tone = !(mixer & (1 << c));
				const noise = !(mixer & (8 << c));
				ch.rawPeriod.push(period);
				ch.rawVolume.push(vol);
				ch.mix.push((tone ? 1 : 0) | (noise ? 2 : 0) | (env ? 4 : 0));
				ch.noise.push(regs[6] & 31);
				if (vol > 0 && (tone || noise || env)) ch.used = true;
				if (noise && vol > 0) ch.noiseUsed = true;
				if (env && vol > 0 && !ch.envelope)
					ch.envelope = { period: regs[11] | (regs[12] << 8), shape: regs[13] & 15 };
			}
		} else if (family === 'sn76489') {
			for (let c = 0; c < 4; c++) {
				const ch = channels[c];
				const att = snAtt[c];
				const vol = att >= 15 ? 0 : 15 - att;
				ch.rawPeriod.push(c < 3 ? snTone[c] : 0);
				ch.rawVolume.push(vol);
				ch.noise.push(snNoise);
				if (vol > 0) ch.used = true;
				if (c === 3) ch.noiseUsed = true;
			}
		} else if (family === 'nes') {
			const enable = regs[0x15];
			for (let c = 0; c < 4; c++) {
				const ch = channels[c];
				const base = c * 4;
				const on = (enable & (1 << c)) !== 0;
				if (c < 2) {
					const reg0 = regs[base];
					ch.rawPeriod.push(regs[base + 2] | ((regs[base + 3] & 7) << 8));
					ch.rawVolume.push(on ? (reg0 & 0x10 ? reg0 & 15 : 15) : 0);
					ch.duty.push(reg0 >> 6);
					ch.dutyUsed = true;
				} else if (c === 2) {
					ch.rawPeriod.push(regs[0x0a] | ((regs[0x0b] & 7) << 8));
					ch.rawVolume.push(on && (regs[0x08] & 0x7f) > 0 ? 15 : 0);
				} else {
					const reg0 = regs[0x0c];
					ch.rawVolume.push(on ? (reg0 & 0x10 ? reg0 & 15 : 15) : 0);
					ch.noise.push(regs[0x0e] & 15);
					ch.mix.push(regs[0x0e] & 0x80 ? 8 : 0);
					ch.noiseUsed = true;
				}
				if (ch.rawVolume[ch.rawVolume.length - 1] > 0) ch.used = true;
			}
		} else {
			for (let c = 0; c < 3; c++) {
				const ch = channels[c];
				const o = c * 7;
				const control = regs[o + 4];
				ch.rawPeriod.push(regs[o] | (regs[o + 1] << 8));
				// the sustain nibble is the level a gated voice settles at: it carries the volume of the effect
				ch.rawVolume.push(control & 1 ? regs[o + 6] >> 4 : 0);
				ch.duty.push(regs[o + 2] | ((regs[o + 3] & 15) << 8));
				ch.dutyUsed = true;
				if (control & 1) {
					ch.used = true;
					ch.waveform ??= control & 0xf0;
					ch.adsr ??= [regs[o + 5] >> 4, regs[o + 5] & 15, 15, regs[o + 6] & 15];
				}
			}
		}
	};

	for (let k = 0; k < ticks; k++) {
		const until = Math.ceil((k * data.timebase) / tickRate);
		while (w < writes.length && writes[w].time <= until) {
			apply(writes[w].addr, writes[w].value);
			w++;
		}
		sample();
	}

	// trim the silent end: the last tick where any used channel still makes a sound
	let last = -1;
	for (const ch of channels)
		if (ch.used) for (let k = ch.rawVolume.length - 1; k > last; k--) if (ch.rawVolume[k] > 0) last = k;
	const length = last + 1;
	if (length <= 0) throw new Error('importSfx: the recording is silent');
	const cut = <T>(a: T[]): T[] => a.slice(0, length);
	const voices: SfxVoiceProgram[] = [];
	channels.forEach((ch, c) => {
		if (!ch.used) return;
		const v: SfxVoiceProgram = { channel: c, rawVolume: { values: cut(ch.rawVolume) } };
		if (family !== 'nes' || c !== 3) if (family !== 'sn76489' || c < 3) v.rawPeriod = { values: cut(ch.rawPeriod) };
		if (ch.mix.length && (family === 'ym2149' || family === 'ay8910' || family === 'nes'))
			v.mix = { values: cut(ch.mix) };
		if (ch.noiseUsed && ch.noise.length) v.noisePeriod = { values: cut(ch.noise) };
		if (ch.dutyUsed && ch.duty.length) v.duty = { values: cut(ch.duty) };
		if (ch.envelope) v.envelope = ch.envelope;
		if (ch.waveform !== undefined) v.waveform = ch.waveform;
		if (ch.adsr) v.adsr = ch.adsr;
		voices.push(v);
	});
	return {
		name: options.name,
		chip: family,
		tickRate,
		length,
		voices,
		priority: options.priority ?? 5,
		retrigger: options.retrigger ?? 'restart',
	};
}

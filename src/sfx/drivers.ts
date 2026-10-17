import type { Chip } from '../chips/Chip.ts';

/** values of one voice program evaluated for the current tick */
export interface VoiceValues {
	/** frequency in Hz (from `pitch`), or undefined when the raw period is given */
	hz?: number;
	rawPeriod?: number;
	/** volume 0..15 (normalised) or undefined */
	volume?: number;
	rawVolume?: number;
	noise?: number;
	mix?: number;
	duty?: number;
	waveform?: number;
	adsr?: [number, number, number, number];
	first: boolean;
}

/**
 * How a sound chip lends a channel to an effect: music writes are filtered through the driver (a channel taken by an
 * effect no longer receives them but they are remembered), the effect writes its own registers, and when it ends the
 * channel gets the state the music last wanted.
 */
export interface ChipDriver {
	readonly channels: number;
	/** a write coming from the music; the driver forwards, filters or merges it */
	music(addr: number, value: number): void;
	claim(channel: number): void;
	release(channel: number): void;
	apply(channel: number, v: VoiceValues): void;
	/** sound off for a claimed channel (the effect is over but the channel is not given back yet) */
	silence(channel: number): void;
	/** lower (gain < 1) the volume of the music on the channels the effects do not use: ducking */
	setDuck?(gain: number): void;
	/** output one sample of digitised sound (level 0..1) through the volume register of the channel */
	pcm(channel: number, level: number): void;
	reset(): void;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** YM2149 / AY-3-8910: 3 tone channels, shared mixer, noise period and hardware envelope */
export class AyDriver implements ChipDriver {
	readonly channels = 3;
	private readonly shadow = new Uint8Array(16);
	private readonly claimed = [false, false, false];
	private sfxMixer = 0xff;
	private noiseOwner = -1;
	private envOwner = -1;
	private duck = 1;

	constructor(private readonly chip: Chip) {
		this.shadow[7] = 0xff;
	}

	reset(): void {
		this.shadow.fill(0);
		this.shadow[7] = 0xff;
		this.claimed.fill(false);
		this.sfxMixer = 0xff;
		this.noiseOwner = this.envOwner = -1;
	}

	private claimMask(): number {
		let m = 0;
		for (let c = 0; c < 3; c++) if (this.claimed[c]) m |= (1 << c) | (8 << c);
		return m;
	}

	private writeMixer(): void {
		const m = this.claimMask();
		this.chip.write(7, (this.shadow[7] & ~m) | (this.sfxMixer & m));
	}

	music(addr: number, value: number): void {
		const r = addr & 15;
		this.shadow[r] = value;
		if (r < 6 && this.claimed[r >> 1]) return;
		if (r >= 8 && r <= 10 && this.claimed[r - 8]) return;
		if (r >= 8 && r <= 10) return this.chip.write(r, this.ducked(value));
		if (r === 7) return this.writeMixer();
		if (r === 6 && this.noiseOwner >= 0) return;
		if ((r === 11 || r === 12 || r === 13) && this.envOwner >= 0) return;
		this.chip.write(r, value);
	}

	/** a music volume with the ducking applied (envelope driven volumes cannot be scaled) */
	private ducked(v: number): number {
		return v & 0x10 || this.duck >= 1 ? v : Math.round((v & 15) * this.duck);
	}

	setDuck(gain: number): void {
		this.duck = gain;
		for (let c = 0; c < 3; c++) if (!this.claimed[c]) this.chip.write(8 + c, this.ducked(this.shadow[8 + c]));
	}

	claim(ch: number): void {
		this.claimed[ch] = true;
		this.sfxMixer |= (1 << ch) | (8 << ch);
		this.chip.write(8 + ch, 0);
		this.writeMixer();
	}

	release(ch: number): void {
		this.claimed[ch] = false;
		if (this.noiseOwner === ch) {
			this.noiseOwner = -1;
			this.chip.write(6, this.shadow[6]);
		}
		if (this.envOwner === ch) {
			this.envOwner = -1;
			this.chip.write(11, this.shadow[11]);
			this.chip.write(12, this.shadow[12]);
		}
		for (const r of [ch * 2, ch * 2 + 1]) this.chip.write(r, this.shadow[r]);
		this.chip.write(8 + ch, this.ducked(this.shadow[8 + ch]));
		this.writeMixer();
	}

	silence(ch: number): void {
		this.chip.write(8 + ch, 0);
	}

	pcm(ch: number, level: number): void {
		// tone and noise off: the channel outputs its volume level, which is the sample
		if ((this.sfxMixer & ((1 << ch) | (8 << ch))) !== ((1 << ch) | (8 << ch))) {
			this.sfxMixer |= (1 << ch) | (8 << ch);
			this.writeMixer();
		}
		this.chip.write(8 + ch, clamp(Math.round(level * 15), 0, 15));
	}

	apply(ch: number, v: VoiceValues): void {
		const clock = this.chip.clock;
		let period = v.rawPeriod;
		if (period === undefined && v.hz) period = Math.round(clock / (16 * v.hz));
		if (period !== undefined) {
			period = clamp(Math.round(period), 1, 4095);
			this.chip.write(ch * 2, period & 255);
			this.chip.write(ch * 2 + 1, period >> 8);
		}
		const mix = v.mix ?? 1;
		this.sfxMixer = (this.sfxMixer & ~((1 << ch) | (8 << ch))) | (mix & 1 ? 0 : 1 << ch) | (mix & 2 ? 0 : 8 << ch);
		if (v.noise !== undefined) {
			this.noiseOwner = ch;
			this.chip.write(6, clamp(Math.round(v.noise), 0, 31));
		}
		this.writeMixer();
		let vol = v.rawVolume ?? (v.volume !== undefined ? Math.round(clamp(v.volume, 0, 15)) : 15);
		vol = clamp(Math.round(vol), 0, 15);
		this.chip.write(8 + ch, mix & 4 ? 0x10 : vol);
	}

	/** hardware envelope registers (period and shape) for an effect */
	setEnvelope(ch: number, period: number, shape: number): void {
		this.envOwner = ch;
		this.chip.write(11, period & 255);
		this.chip.write(12, (period >> 8) & 255);
		this.chip.write(13, shape & 15);
	}
}

/**
 * SN76489: the single byte protocol is re-expressed as complete register writes so that an effect and the music can
 * share the chip without disturbing each other's latch.
 */
export class SnDriver implements ChipDriver {
	readonly channels = 4;
	private readonly tone = new Uint16Array(3);
	private readonly att = new Uint8Array(4).fill(15);
	private noise = 0;
	private latch = 0;
	private duckSteps = 0;
	private readonly claimed = [false, false, false, false];

	constructor(private readonly chip: Chip) {}

	reset(): void {
		this.tone.fill(0);
		this.att.fill(15);
		this.noise = 0;
		this.latch = 0;
		this.claimed.fill(false);
	}

	private emitTone(ch: number, period: number): void {
		this.chip.write(0, 0x80 | (ch << 5) | (period & 15));
		this.chip.write(0, (period >> 4) & 0x3f);
	}
	private emitAtt(ch: number, a: number): void {
		this.chip.write(0, 0x90 | (ch << 5) | (a & 15));
	}

	/** music attenuation with the ducking added (2 dB per step) */
	private duckedAtt(a: number): number {
		return a >= 15 ? 15 : Math.min(15, a + this.duckSteps);
	}

	setDuck(gain: number): void {
		this.duckSteps = gain >= 1 ? 0 : Math.ceil((-20 * Math.log10(Math.max(gain, 0.001))) / 2);
		for (let c = 0; c < 4; c++) if (!this.claimed[c]) this.emitAtt(c, this.duckedAtt(this.att[c]));
	}
	private emitNoise(v: number): void {
		this.chip.write(0, 0xe0 | (v & 7));
	}

	music(_addr: number, byte: number): void {
		if (byte & 0x80) {
			this.latch = (byte >> 4) & 7;
			const reg = this.latch >> 1;
			const isVol = this.latch & 1;
			if (isVol) this.att[reg] = byte & 15;
			else if (reg < 3) this.tone[reg] = (this.tone[reg] & 0x3f0) | (byte & 15);
			else this.noise = byte & 7;
			this.forward(reg, isVol !== 0);
		} else {
			const reg = this.latch >> 1;
			if (this.latch & 1) this.att[reg] = byte & 15;
			else if (reg < 3) this.tone[reg] = ((byte & 0x3f) << 4) | (this.tone[reg] & 15);
			else this.noise = byte & 7;
			this.forward(reg, (this.latch & 1) !== 0);
		}
	}

	private forward(reg: number, isVol: boolean): void {
		if (this.claimed[reg]) return;
		if (isVol) this.emitAtt(reg, this.duckedAtt(this.att[reg]));
		else if (reg < 3) this.emitTone(reg, this.tone[reg]);
		else this.emitNoise(this.noise);
	}

	claim(ch: number): void {
		this.claimed[ch] = true;
	}

	release(ch: number): void {
		this.claimed[ch] = false;
		if (ch < 3) this.emitTone(ch, this.tone[ch]);
		else this.emitNoise(this.noise);
		this.emitAtt(ch, this.duckedAtt(this.att[ch]));
	}

	silence(ch: number): void {
		this.emitAtt(ch, 15);
	}

	pcm(ch: number, level: number): void {
		// a tone period of 1 makes the channel output a constant level that the attenuation then scales
		if (ch < 3 && this.tone[ch] !== 1) this.emitTone(ch, 1);
		this.emitAtt(ch, 15 - clamp(Math.round(level * 15), 0, 15));
	}

	apply(ch: number, v: VoiceValues): void {
		const clock = this.chip.clock;
		if (ch < 3) {
			let period = v.rawPeriod;
			if (period === undefined && v.hz) period = Math.round(clock / (32 * v.hz));
			if (period !== undefined) this.emitTone(ch, clamp(Math.round(period), 1, 1023));
		} else if (v.noise !== undefined) this.emitNoise(clamp(Math.round(v.noise), 0, 7));
		const vol =
			v.rawVolume !== undefined
				? 15 - clamp(Math.round(v.rawVolume), 0, 15)
				: 15 - clamp(Math.round(v.volume ?? 15), 0, 15);
		this.emitAtt(ch, vol);
	}
}

/** NES APU: pulse 1 and 2, triangle, noise, DPCM; the channel enable register $4015 is merged */
export class NesDriver implements ChipDriver {
	readonly channels = 5;
	private readonly shadow = new Uint8Array(0x18);
	private readonly claimed = [false, false, false, false, false];
	private sfxEnable = 0;
	private duck = 1;
	private readonly base = [0x00, 0x04, 0x08, 0x0c, 0x10];

	constructor(private readonly chip: Chip) {}

	reset(): void {
		this.shadow.fill(0);
		this.claimed.fill(false);
		this.sfxEnable = 0;
	}

	private channelOf(reg: number): number {
		return reg < 4 ? 0 : reg < 8 ? 1 : reg < 12 ? 2 : reg < 16 ? 3 : 4;
	}

	private claimMask(): number {
		let m = 0;
		for (let c = 0; c < 5; c++) if (this.claimed[c]) m |= 1 << c;
		return m;
	}

	private writeEnable(): void {
		const m = this.claimMask();
		this.chip.write(0x15, (this.shadow[0x15] & ~m) | (this.sfxEnable & m));
	}

	music(addr: number, value: number): void {
		const reg = (addr >= 0x4000 ? addr - 0x4000 : addr) & 0x1f;
		this.shadow[reg] = value;
		if (reg === 0x15) return this.writeEnable();
		if (reg < 0x14 && this.claimed[this.channelOf(reg)]) return;
		this.chip.write(reg, this.ducked(reg, value));
	}

	/** pulse and noise registers in constant volume mode carry the volume in their low nibble */
	private ducked(reg: number, v: number): number {
		const volumeReg = reg === 0 || reg === 4 || reg === 12;
		return volumeReg && v & 0x10 && this.duck < 1 ? (v & 0xf0) | Math.round((v & 15) * this.duck) : v;
	}

	setDuck(gain: number): void {
		this.duck = gain;
		for (const r of [0, 4, 12])
			if (!this.claimed[this.channelOf(r)]) this.chip.write(r, this.ducked(r, this.shadow[r]));
	}

	claim(ch: number): void {
		this.claimed[ch] = true;
		this.sfxEnable |= 1 << ch;
		this.writeEnable();
	}

	release(ch: number): void {
		this.claimed[ch] = false;
		this.sfxEnable &= ~(1 << ch);
		for (let i = 0; i < 4; i++) {
			const r = this.base[ch] + i;
			this.chip.write(r, this.ducked(r, this.shadow[r]));
		}
		this.writeEnable();
	}

	pcm(_ch: number, level: number): void {
		// the delta counter of the DMC is a 7 bit DAC that $4011 sets directly
		this.chip.write(0x11, clamp(Math.round(level * 127), 0, 127));
	}

	silence(ch: number): void {
		if (ch === 2) this.chip.write(0x08, 0x80);
		else if (ch < 4) this.chip.write(this.base[ch], 0x30);
	}

	private lastHigh = [-1, -1, -1, -1, -1];

	apply(ch: number, v: VoiceValues): void {
		const b = this.base[ch];
		const clock = this.chip.clock;
		const vol = clamp(Math.round(v.rawVolume ?? v.volume ?? 15), 0, 15);
		if (ch < 2) {
			let period = v.rawPeriod;
			if (period === undefined && v.hz) period = Math.round(clock / (16 * v.hz)) - 1;
			this.chip.write(b, ((v.duty ?? 2) << 6) | 0x30 | vol);
			if (period !== undefined) {
				period = clamp(Math.round(period), 0, 0x7ff);
				this.chip.write(b + 2, period & 255);
				// writing the high bits restarts the sequencer: only when needed
				if (v.first || period >> 8 !== this.lastHigh[ch]) this.chip.write(b + 3, 0xf8 | (period >> 8));
				this.lastHigh[ch] = period >> 8;
			}
		} else if (ch === 2) {
			let period = v.rawPeriod;
			if (period === undefined && v.hz) period = Math.round(clock / (32 * v.hz)) - 1;
			this.chip.write(b, vol > 0 ? 0xff : 0x80);
			if (period !== undefined) {
				period = clamp(Math.round(period), 0, 0x7ff);
				this.chip.write(b + 2, period & 255);
				if (v.first || period >> 8 !== this.lastHigh[ch]) this.chip.write(b + 3, 0xf8 | (period >> 8));
				this.lastHigh[ch] = period >> 8;
			}
		} else if (ch === 3) {
			this.chip.write(b, 0x30 | vol);
			if (v.noise !== undefined)
				this.chip.write(b + 2, clamp(Math.round(v.noise), 0, 15) | ((v.mix ?? 0) & 8 ? 0x80 : 0));
			if (v.first) this.chip.write(b + 3, 0xf8);
		}
	}
}

/** MOS SID: three voices of 7 registers each */
export class SidDriver implements ChipDriver {
	readonly channels = 3;
	private readonly shadow = new Uint8Array(32);
	private readonly claimed = [false, false, false];

	constructor(private readonly chip: Chip) {}

	reset(): void {
		this.shadow.fill(0);
		this.claimed.fill(false);
	}

	music(addr: number, value: number): void {
		const r = addr & 31;
		this.shadow[r] = value;
		if (r < 21 && this.claimed[Math.floor(r / 7)]) return;
		this.chip.write(r, value);
	}

	claim(ch: number): void {
		this.claimed[ch] = true;
		// the master volume must be up for an effect to be heard when no music has set it
		if ((this.shadow[24] & 15) === 0) this.chip.write(24, (this.shadow[24] & 0xf0) | 0x0f);
		this.chip.write(ch * 7 + 4, 0);
	}

	release(ch: number): void {
		this.claimed[ch] = false;
		for (const i of [0, 1, 2, 3, 5, 6, 4]) this.chip.write(ch * 7 + i, this.shadow[ch * 7 + i]);
	}

	silence(ch: number): void {
		this.chip.write(ch * 7 + 4, 0);
	}

	pcm(_ch: number, level: number): void {
		// the classic 4 bit digi: the master volume nibble is the DAC
		this.chip.write(24, (this.shadow[24] & 0xf0) | clamp(Math.round(level * 15), 0, 15));
	}

	apply(ch: number, v: VoiceValues): void {
		const o = ch * 7;
		const clock = this.chip.clock;
		let freq = v.rawPeriod;
		if (freq === undefined && v.hz) freq = Math.round((v.hz * 16777216) / clock);
		if (freq !== undefined) {
			freq = clamp(Math.round(freq), 0, 0xffff);
			this.chip.write(o, freq & 255);
			this.chip.write(o + 1, freq >> 8);
		}
		if (v.duty !== undefined) {
			const d = clamp(Math.round(v.duty), 0, 4095);
			this.chip.write(o + 2, d & 255);
			this.chip.write(o + 3, d >> 8);
		}
		const wave = v.waveform ?? 0x20;
		const adsr = v.adsr ?? [0, 8, 15, 4];
		const vol = clamp(Math.round(v.rawVolume ?? v.volume ?? 15), 0, 15);
		if (v.first) {
			this.chip.write(o + 5, (adsr[0] << 4) | adsr[1]);
			this.chip.write(o + 6, (vol << 4) | adsr[3]);
		} else this.chip.write(o + 6, (vol << 4) | adsr[3]);
		this.chip.write(o + 4, wave | (vol > 0 ? 1 : 0));
	}
}

export function driverFor(chip: Chip): ChipDriver | null {
	switch (chip.id) {
		case 'ym2149':
		case 'ay8910':
			return new AyDriver(chip);
		case 'sn76489':
			return new SnDriver(chip);
		case 'nes-apu':
			return new NesDriver(chip);
		case 'sid':
			return new SidDriver(chip);
		default:
			return null;
	}
}

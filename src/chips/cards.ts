import type { Chip, ChipOptions } from './Chip.ts';
import { Opl } from './Opl.ts';
import { PcmDac } from './PcmDac.ts';
import { Saa1099 } from './Saa1099.ts';

/**
 * A card groups several chips behind the I/O ports of the real hardware: `write(port, value)` takes the absolute
 * ISA port (0x220...), exactly what a DOS program (or a recording of its OUT instructions) emits.
 */
export interface SoundCard extends Chip {
	readonly parts: readonly Chip[];
}

export interface CardOptions extends ChipOptions {
	/** base port (default 0x220) */
	base?: number;
}

/**
 * Creative Music System (C/MS) and Game Blaster (CMS-1): two Philips SAA1099 = 12 square / noise voices in stereo.
 * Ports: base+0 data and base+1 address of chip 1, base+2 data and base+3 address of chip 2. Detection ports
 * base+6 (write) / base+0xA, 0xB (read) answer like the real card.
 */
export class CmsCard implements SoundCard {
	readonly id = 'cms';
	readonly name = 'Creative Music System / Game Blaster';
	readonly channels = 12;
	readonly clock: number;
	readonly sampleRate: number;
	readonly parts: readonly Saa1099[];
	private readonly base: number;
	private readonly latch = [0, 0];
	private detect = 0;

	constructor(options: CardOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.clock = options.clock ?? 7_159_090;
		this.base = options.base ?? 0x220;
		this.parts = [
			new Saa1099({ sampleRate: this.sampleRate, clock: this.clock }),
			new Saa1099({ sampleRate: this.sampleRate, clock: this.clock }),
		];
	}

	reset(): void {
		for (const p of this.parts) p.reset();
		this.latch[0] = this.latch[1] = 0;
	}

	write(port: number, value: number): void {
		const o = port - this.base;
		if (o >= 0 && o <= 3) {
			const chip = o >> 1;
			if (o & 1) this.latch[chip] = value & 0x1f;
			else this.parts[chip].write(this.latch[chip], value);
		} else if (o === 6 || o === 7) this.detect = value;
	}

	read(port: number): number {
		const o = port - this.base;
		if (o === 0xa || o === 0xb) return this.detect;
		return 0;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		for (const p of this.parts) p.render(left, right, start, count);
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 12) this.parts[channel < 6 ? 0 : 1].setMuted(channel % 6, muted);
	}
}

export interface SoundBlasterOptions extends CardOptions {
	/** 'sb' (1.x / 2.0: one OPL2, mono DAC), 'sbpro' (two OPL2, left and right) or 'sbpro2' / 'sb16' (one OPL3) */
	model?: 'sb' | 'sbpro' | 'sbpro2' | 'sb16';
}

/**
 * Sound Blaster family: the OPL (ports base+8 / base+9, base+0 / 1 for the left chip and base+2 / 3 for the right
 * chip of a Pro, and the AdLib ports 0x388 / 0x389), and the DSP with direct output (command 0x10), time constant
 * (0x40), speaker on/off (0xD1 / 0xD3) and DMA playback of 8 bit PCM (0x14 single cycle, 0x1C auto-init) from a buffer
 * given with `setDmaBuffer`. DSP version is reported as 2.01 / 3.01 / 4.05 by command 0xE1.
 *
 * Not modelled: ADPCM decoding commands, the analogue mixer registers (stored only) and 16 bit DMA.
 */
export class SoundBlasterCard implements SoundCard {
	readonly id = 'sound-blaster';
	readonly name: string;
	readonly channels: number;
	readonly clock = 0;
	readonly sampleRate: number;
	readonly parts: readonly Chip[];
	private readonly base: number;
	private readonly model: NonNullable<SoundBlasterOptions['model']>;
	private readonly opl: Opl[];
	private readonly dac: PcmDac;
	private oplAddr = [0, 0];
	private dspCommand = -1;
	private dspArgs: number[] = [];
	private dspOut: number[] = [];
	private timeConstant = 131; // 22050 Hz after reset on most drivers
	private speaker = true;
	private dma: Uint8Array | null = null;
	private dmaPos = 0;
	private dmaLeft = 0;
	private dmaAuto = false;
	private dmaFrac = 0;

	constructor(options: SoundBlasterOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.base = options.base ?? 0x220;
		this.model = options.model ?? 'sb';
		const rate = this.sampleRate;
		this.opl =
			this.model === 'sbpro'
				? [new Opl({ sampleRate: rate }), new Opl({ sampleRate: rate })]
				: this.model === 'sb'
					? [new Opl({ sampleRate: rate })]
					: [new Opl({ sampleRate: rate, variant: 'opl3' })];
		this.dac = new PcmDac({ sampleRate: rate });
		this.parts = [...this.opl, this.dac];
		this.channels = this.opl.reduce((n, o) => n + o.channels, 0) + 1;
		this.name = `Sound Blaster (${this.model})`;
	}

	reset(): void {
		for (const p of this.parts) p.reset();
		this.dspCommand = -1;
		this.dspArgs = [];
		this.dspOut = [];
		this.dmaLeft = 0;
		this.dma = null;
		this.speaker = true;
	}

	/** give the DMA engine its source data (what the DOS program put in its DMA buffer) */
	setDmaBuffer(data: Uint8Array): void {
		this.dma = data;
		this.dmaPos = 0;
	}

	/** current DSP sample rate in Hz (from the time constant) */
	get dspRate(): number {
		return 1_000_000 / (256 - this.timeConstant);
	}

	private oplWrite(which: number, reg: number, value: number): void {
		if (this.model === 'sbpro') {
			if (which === -1) for (const o of this.opl) o.write(reg, value);
			else this.opl[which].write(reg, value);
		} else this.opl[0].write(reg, value);
	}

	write(port: number, value: number): void {
		const v = value & 0xff;
		if (port === 0x388 || port === 0x389) {
			const i = port & 1;
			if (i === 0) this.oplAddr[0] = v;
			else this.oplWrite(-1, this.oplAddr[0], v);
			return;
		}
		if (
			this.model !== 'sb' &&
			(this.model === 'sbpro2' || this.model === 'sb16') &&
			(port === 0x38a || port === 0x38b)
		) {
			if (port === 0x38a) this.oplAddr[1] = v;
			else this.opl[0].write(0x100 | this.oplAddr[1], v);
			return;
		}
		const o = port - this.base;
		switch (o) {
			case 0:
			case 2:
			case 8: {
				const idx = o === 2 ? 1 : 0;
				this.oplAddr[idx] = v;
				break;
			}
			case 1:
			case 3:
			case 9: {
				const idx = o === 3 ? 1 : 0;
				this.oplWrite(
					this.model === 'sbpro' && o !== 9 ? idx : o === 9 && this.model === 'sbpro' ? -1 : 0,
					this.oplAddr[idx],
					v,
				);
				break;
			}
			case 6:
				if (v === 0) {
					this.dspCommand = -1;
					this.dmaLeft = 0;
					this.dspOut = [0xaa];
				}
				break;
			case 0xc:
				this.dspWrite(v);
				break;
		}
	}

	private dspWrite(v: number): void {
		if (this.dspCommand < 0) {
			this.dspCommand = v;
			this.dspArgs = [];
			if (v === 0xd1) this.speaker = true;
			else if (v === 0xd3) this.speaker = false;
			else if (v === 0xe1) this.dspOut = this.model === 'sb' ? [2, 1] : this.model === 'sb16' ? [4, 5] : [3, 1];
			else if (v === 0xd0 || v === 0xda || v === 0xd4) this.dmaLeft = v === 0xda ? 0 : this.dmaLeft;
			else if (![0x10, 0x40, 0x14, 0x1c, 0x24, 0x91].includes(v)) {
				this.dspCommand = -1;
				return;
			}
			if (v === 0x1c || v === 0x90 || v === 0x91) {
				// auto-init high-speed / single-cycle commands without arguments
				this.startDma(this.dmaLeft || 0x10000, true);
				this.dspCommand = -1;
			} else if (![0x10, 0x40, 0x14, 0x24].includes(v)) this.dspCommand = -1;
			return;
		}
		this.dspArgs.push(v);
		const cmd = this.dspCommand;
		if (cmd === 0x10) {
			if (this.speaker) this.dac.write(0, v);
			this.dspCommand = -1;
		} else if (cmd === 0x40) {
			this.timeConstant = v;
			this.dspCommand = -1;
		} else if ((cmd === 0x14 || cmd === 0x24) && this.dspArgs.length === 2) {
			this.startDma((this.dspArgs[0] | (this.dspArgs[1] << 8)) + 1, false);
			this.dspCommand = -1;
		}
	}

	private startDma(length: number, auto: boolean): void {
		this.dmaLeft = length;
		this.dmaAuto = auto;
		this.dmaFrac = 0;
	}

	read(port: number): number {
		const o = port - this.base;
		if (o === 0xa) return this.dspOut.length ? this.dspOut.shift()! : 0xff;
		if (o === 0xe) return this.dspOut.length ? 0x80 : 0;
		if (o === 0xc) return 0;
		if (port === 0x388 || o === 8) return 0;
		return 0;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		// OPL chips; the two OPL2 of a Pro are the left and right outputs
		if (this.model === 'sbpro') {
			const tl = new Float32Array(count);
			const tr = new Float32Array(count);
			const ul = new Float32Array(count);
			const ur = new Float32Array(count);
			this.opl[0].render(tl, tr, 0, count);
			this.opl[1].render(ul, ur, 0, count);
			for (let i = 0; i < count; i++) {
				left[start + i] += (tl[i] + tr[i]) / 2;
				right[start + i] += (ul[i] + ur[i]) / 2;
			}
		} else this.opl[0].render(left, right, start, count);
		// DMA playback drives the DAC at the DSP rate, then the DAC adds its held value
		if (this.dmaLeft > 0 && this.dma) {
			const step = this.dspRate / this.sampleRate;
			for (let i = 0; i < count; i++) {
				if (this.dmaLeft > 0 && this.dma) {
					this.dmaFrac += step;
					while (this.dmaFrac >= 1 && this.dmaLeft > 0) {
						this.dmaFrac -= 1;
						this.dac.write(0, this.dma[this.dmaPos % this.dma.length] ?? 0x80);
						this.dmaPos++;
						this.dmaLeft--;
						if (this.dmaLeft === 0 && this.dmaAuto) this.dmaLeft = this.dma.length;
					}
				}
				this.dac.render(left, right, start + i, 1);
			}
			return;
		}
		this.dac.render(left, right, start, count);
	}

	setMuted(channel: number, muted: boolean): void {
		let c = channel;
		for (const o of this.opl) {
			if (c < o.channels) return o.setMuted(c, muted);
			c -= o.channels;
		}
		this.dac.setMuted(0, muted);
	}
}

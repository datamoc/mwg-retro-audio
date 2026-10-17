import type { Chip, ChipOptions } from './Chip.ts';
import { Ym2149 } from './Ym2149.ts';
import { Ym2612 } from './Ym2612.ts';

export interface OpnOptions extends ChipOptions {
	/** 'ym2203' (OPN: 3 FM channels + SSG, default) or 'ym2608' (OPNA: 6 FM channels + SSG) */
	variant?: 'ym2203' | 'ym2608';
}

/**
 * Yamaha YM2203 (OPN) and YM2608 (OPNA) as found in the NEC PC-88 / PC-98, Japanese arcade boards and the MSX
 * turbo R: the FM core of the YM2612 family with 3 or 6 channels, plus the 3 channel SSG (a YM2149 core running at
 * clock / 4, registers 0x00-0x0F). One bank: `write(reg, value)`; the second bank of the YM2608 (FM channels 4-6) is
 * `write(0x100 | reg, value)`. The prescaler registers 0x2D-0x2F select the SSG divider.
 *
 * Not modelled (they need chip ROM data or external memory): the YM2608 rhythm ROM and the ADPCM-A / ADPCM-B
 * sample channels; those register ranges are ignored.
 */
export class Opn implements Chip {
	readonly id: string;
	readonly name: string;
	readonly channels: number;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly fm: Ym2612;
	private ssg: Ym2149;
	private readonly opna: boolean;
	private readonly ssgDivider: number[] = [4];
	private adpcmMem: Uint8Array = new Uint8Array(0);
	private readonly b = {
		start: 0,
		stop: 0,
		delta: 0,
		level: 0,
		pan: 3,
		control: 0,
		limit: 0,
		playing: false,
		pos: 0,
		frac: 0,
		acc: 0,
		step: 127,
		prev: 0,
		nibble: 0,
		repeat: false,
	};

	constructor(options: OpnOptions = {}) {
		this.opna = options.variant === 'ym2608';
		this.id = this.opna ? 'ym2608' : 'ym2203';
		this.name = this.opna ? 'Yamaha YM2608 (OPNA, FM + SSG)' : 'Yamaha YM2203 (OPN)';
		this.sampleRate = options.sampleRate ?? 44100;
		this.clock = options.clock ?? (this.opna ? 7_987_200 : 3_993_600);
		this.fm = new Ym2612({
			sampleRate: this.sampleRate,
			clock: this.clock,
			fmChannels: this.opna ? 6 : 3,
			divider: this.opna ? 144 : 72,
			id: this.id,
		});
		this.channels = this.fm.channels + 3;
		this.ssg = this.newSsg(4);
	}

	private newSsg(divider: number): Ym2149 {
		return new Ym2149({ sampleRate: this.sampleRate, clock: this.clock / divider });
	}

	/** external sample memory of the ADPCM-B channel (the data of VGM block type 0x81) */
	setAdpcmMemory(data: Uint8Array): void {
		this.adpcmMem = data;
	}

	reset(): void {
		this.fm.reset();
		this.ssg.reset();
		Object.assign(this.b, {
			start: 0,
			stop: 0,
			delta: 0,
			level: 0,
			pan: 3,
			control: 0,
			playing: false,
			pos: 0,
			frac: 0,
			acc: 0,
			step: 127,
			prev: 0,
			nibble: 0,
			repeat: false,
		});
	}

	/** register writes of the ADPCM-B block (bank 2, 0x00-0x10) */
	private writeAdpcmB(reg: number, v: number): void {
		const b = this.b;
		switch (reg) {
			case 0x00:
				if (v & 1) b.playing = false;
				else if (v & 0x80) {
					b.playing = true;
					b.pos = b.start << 5;
					b.frac = 0;
					b.acc = 0;
					b.step = 127;
					b.prev = 0;
					b.nibble = 0;
				}
				b.repeat = (v & 0x10) !== 0;
				b.control = v;
				break;
			case 0x01:
				b.pan = v >> 6;
				break;
			case 0x02:
				b.start = (b.start & 0xff00) | v;
				break;
			case 0x03:
				b.start = (b.start & 0xff) | (v << 8);
				break;
			case 0x04:
				b.stop = (b.stop & 0xff00) | v;
				break;
			case 0x05:
				b.stop = (b.stop & 0xff) | (v << 8);
				break;
			case 0x09:
				b.delta = (b.delta & 0xff00) | v;
				break;
			case 0x0a:
				b.delta = (b.delta & 0xff) | (v << 8);
				break;
			case 0x0b:
				b.level = v;
				break;
		}
	}

	/** one decoded ADPCM-B sample at the channel's own rate (-32768..32767), or null when it is not playing */
	private adpcmStep(): number | null {
		const b = this.b;
		if (!b.playing) return null;
		const end = (b.stop + 1) << 5;
		if (b.pos >= end) {
			if (b.repeat) {
				b.pos = b.start << 5;
				b.nibble = 0;
				b.acc = 0;
				b.step = 127;
			} else {
				b.playing = false;
				return null;
			}
		}
		const byte = this.adpcmMem[b.pos] ?? 0;
		const data = b.nibble === 0 ? byte >> 4 : byte & 15;
		if (++b.nibble === 2) {
			b.nibble = 0;
			b.pos++;
		}
		const delta = (b.step * ((data & 7) * 2 + 1)) >> 3;
		b.acc = Math.max(-32768, Math.min(32767, b.acc + (data & 8 ? -delta : delta)));
		b.step = Math.max(127, Math.min(24576, (b.step * [57, 57, 57, 57, 77, 102, 128, 153][data & 7]) >> 6));
		return b.acc;
	}

	write(addr: number, value: number): void {
		const bank = addr & 0x100;
		const reg = addr & 0xff;
		if (!bank && reg < 0x10) this.ssg.write(reg, value);
		else if (!bank && reg >= 0x2d && reg <= 0x2f) {
			// prescaler: 0x2D sets /6 FM and /4 SSG, 0x2E /3 and /2, 0x2F /2 and /1 (OPN); the SSG divider is what matters here
			const divider = reg === 0x2d ? 4 : reg === 0x2e ? 2 : 1;
			if (divider !== this.ssgDivider[0]) {
				this.ssgDivider[0] = divider;
				const old = this.ssg;
				this.ssg = this.newSsg(divider);
				for (let r = 0; r < 14; r++) this.ssg.write(r, old.read(r));
			}
		} else if (!bank && reg < 0x30 && reg >= 0x10) {
			// OPNA rhythm / ADPCM and OPN test registers: not modelled
			if (reg >= 0x20) this.fm.write(reg, value);
		} else if (bank && reg <= 0x10 && this.opna) this.writeAdpcmB(reg, value);
		else this.fm.write(addr, value);
	}

	read(addr: number): number {
		return (addr & 0xff) < 0x10 ? this.ssg.read(addr) : this.fm.read(addr);
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.fm.render(left, right, start, count);
		this.ssg.render(left, right, start, count);
		if (this.opna && this.b.playing) {
			// the delta-T channel runs at (delta / 65536) x the FM native rate; held / interpolated to the output rate
			const b = this.b;
			const ratio = ((b.delta / 65536) * (this.clock / 144)) / this.sampleRate;
			const gain = ((b.level / 255) * 0.5) / 32768;
			for (let i = 0; i < count && b.playing; i++) {
				b.frac += ratio;
				while (b.frac >= 1 && b.playing) {
					b.frac -= 1;
					const next = this.adpcmStep();
					if (next === null) break;
					b.prev = next;
				}
				if (b.pan & 2) left[start + i] += b.prev * gain;
				if (b.pan & 1) right[start + i] += b.prev * gain;
			}
		}
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel < this.fm.channels) this.fm.setMuted(channel, muted);
		else this.ssg.setMuted(channel - this.fm.channels, muted);
	}
}

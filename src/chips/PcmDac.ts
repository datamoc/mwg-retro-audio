import type { Chip, ChipOptions } from './Chip.ts';

export interface PcmDacOptions extends ChipOptions {
	/** resolution of the written values: 8 (unsigned, 0x80 = silence; default) or 16 (signed) */
	bits?: 8 | 16;
	/** output channels: 'mono' (default), or stereo through `write(1, ...)` for the right side */
	stereo?: boolean;
}

/**
 * A plain sample DAC held at the last written value: the Covox Speech Thing and Disney Sound Source on the printer
 * port, the direct-output command of the Sound Blaster DSP, the Mega Drive / Amiga style one-sample-at-a-time
 * playback. The program writes samples at its own rate, with sample accurate timing as in a register log:
 * `write(0, v)` sets the left (or mono) value, `write(1, v)` the right one.
 *
 * Zero-order hold is what these devices do; the anti-aliasing of the real analogue stage is the job of the output
 * stage (see the `soundBlasterDac` profile).
 */
export class PcmDac implements Chip {
	readonly id = 'pcm-dac';
	readonly name = 'Sample DAC (Covox / Sound Blaster direct)';
	readonly channels = 1;
	readonly clock = 0;
	readonly sampleRate: number;
	private readonly bits: 8 | 16;
	private readonly stereo: boolean;
	private left = 0;
	private right = 0;
	private muted = false;

	constructor(options: PcmDacOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.bits = options.bits ?? 8;
		this.stereo = options.stereo ?? false;
	}

	reset(): void {
		this.left = this.right = 0;
	}

	private scale(v: number): number {
		return this.bits === 8 ? ((v & 0xff) - 128) / 128 : (((v & 0xffff) << 16) >> 16) / 32768;
	}

	write(addr: number, value: number): void {
		const x = this.scale(value);
		if (addr === 1 && this.stereo) this.right = x;
		else {
			this.left = x;
			if (!this.stereo) this.right = x;
		}
	}

	read(): number {
		return 0;
	}

	setMuted(_channel: number, muted: boolean): void {
		this.muted = muted;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		if (this.muted) return;
		for (let i = 0; i < count; i++) {
			left[start + i] += this.left;
			right[start + i] += this.right;
		}
	}
}

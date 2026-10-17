/**
 * Plug-in for @datamoc/mw_retro_audio (MPL-2.0): makes the bit-exact Hatari YM2149 chain available as the 'ym2149'
 * chip of that engine. The engine itself never depends on this GPL package; an application that wants Hatari's exact
 * Atari ST sound installs both and registers the factory:
 *
 *   import { registerChip } from '@datamoc/mw_retro_audio/chips';
 *   import { registerHatariYm } from 'hatari-ym/chip';
 *   registerHatariYm(registerChip);
 *
 * The object below only has to look like the engine's `Chip` interface (structural typing), so there is no import
 * of the engine here.
 *
 * Copyright (C) the Hatari authors; distributed under the GNU GPL v2 or later like the rest of this package.
 */
import { HatariYm, MACHINE_CLOCKS, type HatariYmOptions } from './ym2149.ts';

export interface HatariChipOptions {
	sampleRate?: number;
	/** YM clock in Hz: the Atari ST PAL / NTSC clocks select the matching Hatari machine */
	clock?: number;
	lowPass?: HatariYmOptions['lowPass'];
	highPass?: HatariYmOptions['highPass'];
	resample?: HatariYmOptions['resample'];
}

/** Hatari YM2149 behind the chip interface: register writes are timed to the sample, audio is pulled in blocks */
export class HatariYmChip {
	readonly id = 'ym2149';
	readonly name = 'Hatari YM2149 (bit-exact Atari ST chain)';
	readonly channels = 3;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly ym: HatariYm;
	private readonly startClock: number;
	private frames = 0;
	private queue = new Float32Array(0);
	private readonly muted = [false, false, false];

	constructor(options: HatariChipOptions = {}) {
		const clock = options.clock ?? MACHINE_CLOCKS['stf-pal'].ymFreq;
		this.clock = clock;
		this.sampleRate = options.sampleRate ?? 44100;
		const known = (Object.keys(MACHINE_CLOCKS) as (keyof typeof MACHINE_CLOCKS)[]).find((m) => MACHINE_CLOCKS[m].ymFreq === clock);
		this.ym = new HatariYm({
			...(known ? { machine: known } : { ymFreq: clock, cpuFreq: clock * 4 }),
			sampleRate: this.sampleRate,
			lowPass: options.lowPass,
			highPass: options.highPass,
			resample: options.resample,
		});
		this.startClock = Math.round(this.ym.cpuFreq * 0.5);
		this.reset();
	}

	private now(): number {
		return this.startClock + Math.round((this.frames * this.ym.cpuFreq) / this.sampleRate);
	}

	reset(): void {
		this.ym.reset(0);
		this.frames = 0;
		this.queue = new Float32Array(0);
	}

	write(addr: number, value: number): void {
		this.ym.writeData(this.now(), addr & 15, value);
	}

	read(): number {
		return 0;
	}

	setMuted(channel: number, muted: boolean): void {
		// the exact chain mixes through the measured 3-voice table: muting is done by the caller's mixer
		if (channel >= 0 && channel < 3) this.muted[channel] = muted;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.frames += count;
		this.ym.update(this.now());
		const fresh = this.ym.takeSamples();
		if (fresh.length) {
			const merged = new Float32Array(this.queue.length + fresh.length);
			merged.set(this.queue);
			for (let i = 0; i < fresh.length; i++) merged[this.queue.length + i] = fresh[i] / 32768;
			this.queue = merged;
		}
		const n = Math.min(count, this.queue.length);
		for (let i = 0; i < n; i++) {
			left[start + i] += this.queue[i];
			right[start + i] += this.queue[i];
		}
		this.queue = this.queue.subarray(n);
	}
}

/** register the chip as 'ym2149' in the engine's chip registry (`registerChip` of `@datamoc/mw_retro_audio/chips`) */
export function registerHatariYm(registerChip: (id: string, factory: (o: HatariChipOptions & Record<string, unknown>) => HatariYmChip) => void): void {
	registerChip('ym2149', (o) => new HatariYmChip(o));
}

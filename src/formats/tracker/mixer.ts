import type { Chip } from '../../chips/Chip.ts';
import type { Sample } from './types.ts';

export type Interpolation = 'none' | 'linear';
export type AmigaFilter = 'off' | 'a500' | 'a1200';

/** state of one playing voice of the mixer */
export class MixVoice {
	sample: Sample | null = null;
	pos = 0;
	/** source frames per output frame (playback frequency / output rate) */
	step = 0;
	dir = 1;
	volL = 0;
	volR = 0;
	curL = 0;
	curR = 0;
	active = false;
	muted = false;
}

export interface MixerOptions {
	sampleRate: number;
	voices: number;
	interpolation?: Interpolation;
	/** volume change ramp in output samples at tick boundaries (declick); 0 = none (Paula-exact) */
	ramp?: number;
	amigaFilter?: AmigaFilter;
}

/**
 * Sample mixer used by the module player, modelled as a chip so it plugs into the same pipeline as the others:
 * Paula-style "nearest sample" playback or linear interpolation, per-voice volume and panning with a short
 * ramp to avoid clicks, forward and ping-pong loops, and the optional Amiga hardware low-pass (A500: 4.9 kHz
 * one-pole + the LED filter, A1200: only the LED filter).
 */
export class ModuleMixer implements Chip {
	readonly id = 'tracker';
	readonly name = 'Sample mixer';
	readonly channels: number;
	readonly clock = 0;
	readonly sampleRate: number;
	readonly voices: MixVoice[];
	private readonly interp: Interpolation;
	private readonly ramp: number;
	private readonly filter: AmigaFilter;
	private readonly lp = [0, 0, 0, 0, 0, 0];
	/** state of the Amiga LED filter (E00 turns it on, E01 off) */
	led = false;

	constructor(options: MixerOptions) {
		this.sampleRate = options.sampleRate;
		this.channels = options.voices;
		this.voices = Array.from({ length: options.voices }, () => new MixVoice());
		this.interp = options.interpolation ?? 'linear';
		this.ramp = options.ramp ?? 64;
		this.filter = options.amigaFilter ?? 'off';
	}

	reset(): void {
		for (const v of this.voices) Object.assign(v, new MixVoice());
		this.lp.fill(0);
		this.led = false;
	}

	write(): void {}
	read(): number {
		return 0;
	}
	setMuted(channel: number, muted: boolean): void {
		if (this.voices[channel]) this.voices[channel].muted = muted;
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const useLinear = this.interp === 'linear';
		let mixL = new Float32Array(count);
		let mixR = new Float32Array(count);
		for (const v of this.voices) {
			const s = v.sample;
			if (!v.active || !s || s.data.length === 0 || v.muted) {
				v.curL = v.volL;
				v.curR = v.volR;
				continue;
			}
			const data = s.data;
			const end = s.loopType ? Math.min(s.loopEnd, data.length) : data.length;
			const loopStart = s.loopStart;
			const rampN = this.ramp;
			const dL = rampN ? (v.volL - v.curL) / rampN : 0;
			const dR = rampN ? (v.volR - v.curR) / rampN : 0;
			let n = 0;
			for (; n < count; n++) {
				let i = Math.floor(v.pos);
				let guard = 0;
				while ((i >= end || i < 0) && guard++ < 8) {
					if (s.loopType === 1 && end > loopStart) {
						v.pos = loopStart + ((v.pos - loopStart) % (end - loopStart));
					} else if (s.loopType === 2 && end > loopStart) {
						// ping-pong: reflect around the loop ends
						if (v.dir > 0) {
							v.pos = 2 * end - v.pos - 1;
							v.dir = -1;
						} else {
							v.pos = 2 * loopStart - v.pos + 1;
							v.dir = 1;
						}
					} else break;
					i = Math.floor(v.pos);
				}
				if (i >= end || i < 0) {
					v.active = false;
					break;
				}
				let x = data[i];
				if (useLinear) {
					const frac = v.pos - i;
					let j = i + v.dir;
					if (s.loopType === 1 && j >= end) j = loopStart;
					else if (j >= data.length || j < 0) j = i;
					x += (data[j] - x) * (v.dir > 0 ? frac : 1 - frac);
				}
				if (rampN && n < rampN) {
					v.curL += dL;
					v.curR += dR;
				} else {
					v.curL = v.volL;
					v.curR = v.volR;
				}
				mixL[n] += x * v.curL;
				mixR[n] += x * v.curR;
				v.pos += v.step * v.dir;
			}
			if (n >= count) {
				v.curL = v.volL;
				v.curR = v.volR;
			}
		}
		if (this.filter !== 'off') {
			const rc = Math.exp((-2 * Math.PI * 4900) / this.sampleRate);
			const led = Math.exp((-2 * Math.PI * 3275) / this.sampleRate);
			[mixL, mixR].forEach((buf, ch) => {
				for (let i = 0; i < count; i++) {
					let y = buf[i];
					if (this.filter === 'a500') {
						this.lp[ch] = (1 - rc) * y + rc * this.lp[ch];
						y = this.lp[ch];
					}
					if (this.led) {
						// the "LED" filter, switched by the music with E0x: two cascaded poles near 3.3 kHz
						this.lp[2 + ch] = (1 - led) * y + led * this.lp[2 + ch];
						this.lp[4 + ch] = (1 - led) * this.lp[2 + ch] + led * this.lp[4 + ch];
						y = this.lp[4 + ch];
					}
					buf[i] = y;
				}
			});
		}
		for (let i = 0; i < count; i++) {
			left[start + i] += mixL[i];
			right[start + i] += mixR[i];
		}
	}
}

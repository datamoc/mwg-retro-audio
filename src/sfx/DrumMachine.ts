/** The drum voices of the machine */
export type DrumVoice = 'kick' | 'snare' | 'hat' | 'openHat' | 'clap' | 'tom';

export interface DrumMachineOptions {
	sampleRate?: number;
}

/** One hit: the voice, its start in seconds and an optional velocity 0..1 */
export interface DrumHit {
	voice: DrumVoice;
	time: number;
	velocity?: number;
}

/** Synthesised drum sounds (analogue style: sine sweeps and filtered noise), no samples */
export class DrumMachine {
	readonly sampleRate: number;
	private noiseState = 0x2545f491;

	constructor(options: DrumMachineOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
	}

	/** Render a list of hits into one mono buffer of `seconds` length; hits that do not fit are cut */
	render(hits: readonly DrumHit[], seconds: number): Float32Array {
		const out = new Float32Array(Math.round(seconds * this.sampleRate));
		for (const hit of hits) {
			const sound = this.hit(hit.voice);
			const start = Math.round(hit.time * this.sampleRate);
			const velocity = hit.velocity ?? 1;
			for (let i = 0; i < sound.length && start + i < out.length; i++) out[start + i] += sound[i] * velocity;
		}
		return out;
	}

	/** Hits of a step pattern: one character per step (`x` hit, `X` accent, anything else a rest) */
	pattern(voice: DrumVoice, steps: string, bpm: number, stepsPerBeat = 4, bars = 1): DrumHit[] {
		const hits: DrumHit[] = [];
		const stepSeconds = 60 / bpm / stepsPerBeat;
		for (let bar = 0; bar < bars; bar++)
			for (let k = 0; k < steps.length; k++) {
				const c = steps[k];
				if (c === 'x' || c === 'X')
					hits.push({ voice, time: (bar * steps.length + k) * stepSeconds, velocity: c === 'X' ? 1 : 0.7 });
			}
		return hits;
	}

	private noise(): number {
		this.noiseState = (Math.imul(this.noiseState, 1664525) + 1013904223) >>> 0;
		return this.noiseState / 0x80000000 - 1;
	}

	private hit(voice: DrumVoice): Float32Array {
		const rate = this.sampleRate;
		const make = (seconds: number, f: (t: number, i: number) => number): Float32Array => {
			const x = new Float32Array(Math.round(seconds * rate));
			for (let i = 0; i < x.length; i++) x[i] = f(i / rate, i);
			return x;
		};
		switch (voice) {
			case 'kick': {
				let phase = 0;
				return make(0.35, (t) => {
					phase += (2 * Math.PI * (45 + 110 * Math.exp(-t * 30))) / rate;
					return Math.sin(phase) * Math.exp(-t * 9);
				});
			}
			case 'tom': {
				let phase = 0;
				return make(0.3, (t) => {
					phase += (2 * Math.PI * (110 + 90 * Math.exp(-t * 25))) / rate;
					return Math.sin(phase) * Math.exp(-t * 11);
				});
			}
			case 'snare': {
				let phase = 0;
				return make(0.22, (t) => {
					phase += (2 * Math.PI * (190 + 60 * Math.exp(-t * 40))) / rate;
					return 0.5 * Math.sin(phase) * Math.exp(-t * 25) + 0.6 * this.noise() * Math.exp(-t * 18);
				});
			}
			case 'clap':
				return make(0.2, (t) => {
					const bursts = [0, 0.012, 0.024].reduce((s, d) => s + (t >= d ? Math.exp(-(t - d) * 120) : 0), 0);
					return this.noise() * (bursts * 0.4 + Math.exp(-t * 25) * 0.4);
				});
			case 'hat':
			case 'openHat': {
				const decay = voice === 'hat' ? 70 : 12;
				let previous = 0;
				return make(voice === 'hat' ? 0.06 : 0.35, (t) => {
					const n = this.noise();
					const high = n - previous; // first difference: a simple high-pass
					previous = n;
					return high * 0.5 * Math.exp(-t * decay);
				});
			}
		}
	}
}

/** One control frame of the formant synthesizer; values are held then interpolated towards the next frame */
export interface SpeechFrame {
	/** duration in seconds */
	duration: number;
	/** fundamental frequency in Hz (0 for an unvoiced sound) */
	f0: number;
	/** formant frequencies F1..F3 in Hz */
	formants: readonly [number, number, number];
	/** formant bandwidths B1..B3 in Hz */
	bandwidths: readonly [number, number, number];
	/** voicing amplitude 0..1 */
	voice: number;
	/** frication / aspiration noise amplitude 0..1 */
	noise: number;
}

/** Source waveform: a smooth glottal pulse for speech, a bright sawtooth for the 1980s vocoder voice */
export type SourceShape = 'glottal' | 'saw';

export interface FormantSynthOptions {
	sampleRate?: number;
	source?: SourceShape;
	/** vibrato depth as a share of the pitch (0.006 = about 10 cents) and rate in Hz; none by default */
	vibrato?: number;
	vibratoRate?: number;
	/** phase of the vibrato at the start, 0..1, so that voices doubled in a chorus do not wobble together */
	vibratoPhase?: number;
	/** random variation of the length of each pitch period, as a share of the period (0.004 = 0.4 %); none by default */
	jitter?: number;
}

const UPDATE_INTERVAL = 16;

/** Second order resonator (Klatt 1980) with unity gain at DC */
export class Resonator {
	private a = 0;
	private b = 0;
	private c = 0;
	private y1 = 0;
	private y2 = 0;

	set(frequency: number, bandwidth: number, sampleRate: number): void {
		const r = Math.exp((-Math.PI * bandwidth) / sampleRate);
		this.c = -r * r;
		this.b = 2 * r * Math.cos((2 * Math.PI * frequency) / sampleRate);
		this.a = 1 - this.b - this.c;
	}

	process(x: number): number {
		const y = this.a * x + this.b * this.y1 + this.c * this.y2;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}
}

/**
 * One sample of the voice source at `phase` (0..1). `glottal` is the derivative of a Rosenberg flow pulse (a cosine
 * opening for 40 % of the period and a faster cosine closing for 16 %), which includes the radiation of the lips: it
 * is continuous, has no jump at the end of the cycle and keeps the 6 dB per octave tilt of a real voice. `saw` is a
 * bright sawtooth for the 1980s vocoder carrier.
 */
export function glottalPulse(phase: number, source: SourceShape): number {
	if (source === 'saw') return 2 * phase - 1;
	const opening = 0.4;
	const closing = 0.16;
	if (phase < opening) return 0.1 * (0.5 * (Math.PI / opening)) * Math.sin((Math.PI * phase) / opening) * 3.3;
	if (phase < opening + closing)
		return -0.1 * (Math.PI / (2 * closing)) * Math.sin((Math.PI * (phase - opening)) / (2 * closing)) * 3.3;
	return 0;
}

/** Cascade formant synthesizer (Klatt style, three formants), rendering a list of frames into mono samples */
export class FormantSynth {
	readonly sampleRate: number;
	private readonly source: SourceShape;
	private readonly resonators = [new Resonator(), new Resonator(), new Resonator()];
	/** the two upper formants are fixed, they give the voice its presence */
	private readonly upper = [new Resonator(), new Resonator()];
	private readonly vibrato: number;
	private readonly vibratoRate: number;
	private vibratoPhase: number;
	private readonly jitter: number;
	private jitterFactor = 1;
	private phase = 0;
	private noiseState = 0x1234567;

	constructor(options: FormantSynthOptions = {}) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.source = options.source ?? 'glottal';
		this.vibrato = options.vibrato ?? 0;
		this.vibratoRate = options.vibratoRate ?? 5.5;
		this.vibratoPhase = options.vibratoPhase ?? 0;
		this.jitter = options.jitter ?? 0;
		this.upper[0].set(3300, 250, this.sampleRate);
		this.upper[1].set(3750, 200, this.sampleRate);
	}

	render(frames: readonly SpeechFrame[]): Float32Array {
		const rate = this.sampleRate;
		const lengths = frames.map((f) => Math.round(f.duration * rate));
		const out = new Float32Array(lengths.reduce((a, b) => a + b, 0));
		let pos = 0;
		for (let i = 0; i < frames.length; i++) {
			const cur = frames[i];
			const next = frames[i + 1] ?? cur;
			const n = lengths[i];
			for (let k = 0; k < n; k++) {
				// glide over the second half of the frame towards the next one, so transitions are continuous
				const t = Math.max(0, (k / n - 0.5) * 2);
				if (k % UPDATE_INTERVAL === 0) {
					for (let j = 0; j < 3; j++) {
						const f = cur.formants[j] + (next.formants[j] - cur.formants[j]) * t;
						const b = cur.bandwidths[j] + (next.bandwidths[j] - cur.bandwidths[j]) * t;
						this.resonators[j].set(f, b, rate);
					}
				}
				const f0 = next.f0 > 0 && cur.f0 > 0 ? cur.f0 + (next.f0 - cur.f0) * t : cur.f0;
				const voice = cur.voice + (next.voice - cur.voice) * t;
				const noise = cur.noise + (next.noise - cur.noise) * t;
				let s = 0;
				if (f0 > 0) {
					this.vibratoPhase += this.vibratoRate / rate;
					const bend = 1 + this.vibrato * Math.sin(2 * Math.PI * this.vibratoPhase);
					this.phase += (f0 * bend * this.jitterFactor) / rate;
					if (this.phase >= 1) {
						this.phase -= 1;
						if (this.jitter > 0) this.jitterFactor = 1 + this.jitter * this.noise();
					}
					s += voice * glottalPulse(this.phase, this.source);
				}
				if (noise > 0) s += noise * this.noise();
				for (const r of this.resonators) s = r.process(s);
				for (const r of this.upper) s = r.process(s);
				out[pos++] = s;
			}
		}
		return out;
	}

	private noise(): number {
		this.noiseState = (Math.imul(this.noiseState, 1664525) + 1013904223) >>> 0;
		return this.noiseState / 0x80000000 - 1;
	}
}

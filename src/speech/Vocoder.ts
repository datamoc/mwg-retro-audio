export interface VocoderOptions {
	sampleRate?: number;
	/** number of analysis / synthesis bands (default 16) */
	bands?: number;
	/** lowest and highest band centre in Hz (default 120 .. 6000) */
	low?: number;
	high?: number;
	/** quality factor of every band filter (default 6) */
	q?: number;
	/** envelope follower attack and release in seconds (default 0.003 and 0.02) */
	attack?: number;
	release?: number;
}

/** Band-pass biquad (constant 0 dB peak gain, RBJ cookbook) */
class BandPass {
	private readonly b0: number;
	private readonly b2: number;
	private readonly a1: number;
	private readonly a2: number;
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;

	constructor(frequency: number, q: number, sampleRate: number) {
		const w = (2 * Math.PI * frequency) / sampleRate;
		const alpha = Math.sin(w) / (2 * q);
		const a0 = 1 + alpha;
		this.b0 = alpha / a0;
		this.b2 = -alpha / a0;
		this.a1 = (-2 * Math.cos(w)) / a0;
		this.a2 = (1 - alpha) / a0;
	}

	process(x: number): number {
		const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}
}

/**
 * Channel vocoder, the effect behind the robot voices of late 1970s records: the spectral envelope of a
 * `modulator` (speech) is measured in a bank of band-pass filters and imposed on a `carrier` (a synthesizer chord
 * or a buzz) filtered by the same bank. The result has the pitch of the carrier and the articulation of the voice.
 * Both signals must share the sample rate; the output has the length of the shorter one.
 */
export function vocode(modulator: Float32Array, carrier: Float32Array, options: VocoderOptions = {}): Float32Array {
	const rate = options.sampleRate ?? 44100;
	const bands = options.bands ?? 16;
	const low = options.low ?? 120;
	const high = Math.min(options.high ?? 6000, rate * 0.45);
	const q = options.q ?? 6;
	const attack = 1 - Math.exp(-1 / (rate * (options.attack ?? 0.003)));
	const release = 1 - Math.exp(-1 / (rate * (options.release ?? 0.02)));
	const length = Math.min(modulator.length, carrier.length);
	const out = new Float32Array(length);
	for (let band = 0; band < bands; band++) {
		const frequency = low * (high / low) ** (bands === 1 ? 0 : band / (bands - 1));
		const analysis = new BandPass(frequency, q, rate);
		const synthesis = new BandPass(frequency, q, rate);
		let envelope = 0;
		for (let i = 0; i < length; i++) {
			const level = Math.abs(analysis.process(modulator[i]));
			envelope += (level - envelope) * (level > envelope ? attack : release);
			out[i] += synthesis.process(carrier[i]) * envelope;
		}
	}
	return out;
}

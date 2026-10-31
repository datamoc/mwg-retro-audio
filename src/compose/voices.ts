import type { Timbre } from './styles.ts';

export interface NoteShape {
	/** attack and release in seconds */
	attack: number;
	release: number;
	/** exponential decay rate while the note is held (0 = sustained) */
	decay: number;
}

export const midiToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

/** One note of a simple subtractive / FM voice, `seconds` long plus its release tail */
export function renderNote(timbre: Timbre, hz: number, seconds: number, rate: number, shape: NoteShape): Float32Array {
	const length = Math.round((seconds + shape.release) * rate);
	const held = Math.round(seconds * rate);
	const out = new Float32Array(length);
	let phase = 0;
	for (let i = 0; i < length; i++) {
		const t = i / rate;
		phase += hz / rate;
		if (phase >= 1) phase -= 1;
		let envelope = Math.min(1, t / Math.max(shape.attack, 1e-4)) * Math.exp(-shape.decay * t);
		if (i >= held) envelope *= Math.max(0, 1 - (i - held) / Math.max(1, length - held));
		out[i] = wave(timbre, phase, t, hz) * envelope;
	}
	if (timbre === 'fm') return out;
	// the raw waves are filtered like the analogue and tracker voices they imitate: a one pole low-pass that follows the pitch
	const a = 1 - Math.exp((-2 * Math.PI * Math.min(4000, hz * 6)) / rate);
	let y = 0;
	for (let i = 0; i < length; i++) {
		y += (out[i] - y) * a;
		out[i] = y;
	}
	return out;
}

function wave(timbre: Timbre, phase: number, t: number, hz: number): number {
	switch (timbre) {
		case 'saw':
			return 2 * phase - 1;
		case 'square':
			return phase < 0.5 ? 1 : -1;
		case 'pulse':
			return phase < 0.25 ? 1 : -1;
		case 'triangle':
			return 4 * Math.abs(phase - 0.5) - 1;
		case 'fm': {
			// two operator FM, the modulator decaying like an OPL2 patch
			const index = 2.2 * Math.exp(-4 * t);
			return Math.sin(2 * Math.PI * phase + index * Math.sin(2 * Math.PI * ((hz * 2 * t) % 1)));
		}
	}
}

/** Add `sound` into the circular buffers at `start`, wrapping at the end so a loop has no seam */
export function mixLooped(
	left: Float32Array,
	right: Float32Array,
	sound: Float32Array,
	start: number,
	gainLeft: number,
	gainRight: number,
): void {
	const n = left.length;
	for (let i = 0; i < sound.length; i++) {
		const k = (start + i) % n;
		left[k] += sound[i] * gainLeft;
		right[k] += sound[i] * gainRight;
	}
}

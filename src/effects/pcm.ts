import { OutputStage, type OutputStageOptions } from '../driver/OutputStage.ts';
import { retroEffects, type RetroEffectName, type RetroEffectPreset } from './presets.ts';
import type { RetroEffectStage } from './chain.ts';

export interface RetroEffectProcessing {
	readonly preset: RetroEffectPreset;
	/** stages applied, in signal order */
	readonly stages: readonly RetroEffectStage[];
	/** requested stages this call could not apply (none on the offline path today) */
	readonly omitted: readonly string[];
}

/** sample-and-hold: each output frame repeats the last frame captured at the target rate */
function decimate(left: Float32Array, right: Float32Array, sampleRate: number, targetRate: number): void {
	const ratio = Math.max(1, sampleRate / targetRate);
	const frames = Math.min(left.length, right.length);
	let phase = 0;
	let heldLeft = 0;
	let heldRight = 0;
	for (let i = 0; i < frames; i++) {
		if (phase <= 0) {
			heldLeft = left[i];
			heldRight = right[i];
			phase += ratio;
		}
		left[i] = heldLeft;
		right[i] = heldRight;
		phase -= 1;
	}
}

function drive(left: Float32Array, right: Float32Array, amount: number): void {
	if (amount <= 1) return;
	const normaliser = Math.tanh(amount);
	for (let i = 0; i < left.length; i++) left[i] = Math.tanh(left[i] * amount) / normaliser;
	for (let i = 0; i < right.length; i++) right[i] = Math.tanh(right[i] * amount) / normaliser;
}

/**
 * Apply a retro effect preset to stereo PCM in place, deterministically and without a browser:
 * sample-and-hold, bitcrush/DAC non-linearity, low-pass, DC removal and gain, using the same
 * `OutputStage` as every other offline render.
 *
 * @example
 * ```ts
 * const { left, right } = renderSfx(definition, 0.5, { effects: 'sid' });
 * ```
 */
export function processRetroEffects(
	left: Float32Array,
	right: Float32Array,
	sampleRate: number,
	preset: RetroEffectName | RetroEffectPreset,
): RetroEffectProcessing {
	const resolved = retroEffects(preset);
	const stages: RetroEffectStage[] = [];
	if (resolved.highpass) stages.push('highpass');
	if (resolved.sampleRateReduction) {
		decimate(left, right, sampleRate, resolved.sampleRateReduction.rate);
		stages.push('sample-rate-reduction');
	}
	if (resolved.bitcrush) {
		drive(left, right, resolved.bitcrush.drive ?? 1);
		stages.push('bitcrush');
	}
	if (resolved.dac) stages.push('dac');
	if (
		resolved.sampleRateReduction ||
		resolved.bitcrush ||
		resolved.dac ||
		resolved.lowpass ||
		resolved.highpass ||
		(resolved.gain !== undefined && resolved.gain !== 1)
	) {
		const bitValues = [resolved.bitcrush?.bits, resolved.dac?.bits].filter(
			(value): value is number => value !== undefined,
		);
		const options: OutputStageOptions = {
			lowpass: resolved.lowpass?.frequency ?? 0,
			lowpassOrder: resolved.lowpass?.order ?? 1,
			lowpassQ: resolved.lowpass?.q,
			dcBlock: resolved.highpass !== undefined,
			dcCutoff: resolved.highpass?.frequency ?? 5,
			dacBits: bitValues.length ? Math.min(...bitValues) : 0,
			dacCrossover: resolved.dac?.crossover ?? 0,
			gain: resolved.gain ?? 1,
		};
		new OutputStage(sampleRate, options).process(left, right, 0, Math.min(left.length, right.length));
	}
	if (resolved.lowpass) stages.push('lowpass');
	if (resolved.gain !== undefined && resolved.gain !== 1) stages.push('gain');
	return { preset: resolved, stages, omitted: [] };
}

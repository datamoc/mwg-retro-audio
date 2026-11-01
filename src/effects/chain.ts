import { crossover, quantize } from '../driver/OutputStage.ts';
import { retroEffects, type RetroEffectName, type RetroEffectPreset } from './presets.ts';

/** a stage a chain actually applies, in signal order */
export type RetroEffectStage = 'highpass' | 'sample-rate-reduction' | 'bitcrush' | 'dac' | 'lowpass' | 'gain';

export interface RetroEffectChainOptions {
	/**
	 * Connect the chain's nodes internally (the default). Pass `false` when a host inserts the
	 * nodes one by one in `nodes` order, as mwg 0.53's `Channel.insert` does.
	 */
	connect?: boolean;
}

export interface RetroEffectChain {
	/** the preset currently applied */
	readonly preset: RetroEffectPreset;
	/** connect a source here */
	readonly input: AudioNode;
	/** connect this to the destination */
	readonly output: AudioNode;
	/** every node in signal order, for a host that wires or inserts them itself */
	readonly nodes: readonly AudioNode[];
	/** stages applied, in signal order */
	readonly stages: readonly RetroEffectStage[];
	/** requested stages this context cannot build (today: sample-rate reduction without `createScriptProcessor`) */
	readonly omitted: readonly string[];
	/** change the preset in place: no reconnection, no click */
	setPreset(preset: RetroEffectName | RetroEffectPreset): void;
	dispose(): void;
}

const CURVE_POINTS = 4096;
const DEFAULT_Q = Math.SQRT1_2;

interface Decimator {
	readonly node: AudioNode;
	setRate(rate: number | undefined): void;
	dispose(): void;
}

/**
 * Sample-and-hold decimation. Web Audio has no built-in rate reducer, so this uses the
 * broadly available (if deprecated) `ScriptProcessorNode`. A context that does not expose it
 * leaves the stage out and says so in `omitted`.
 */
function createDecimator(context: BaseAudioContext): Decimator | null {
	if (typeof context.createScriptProcessor !== 'function') return null;
	let node: ScriptProcessorNode;
	try {
		node = context.createScriptProcessor(1024, 2, 2);
	} catch {
		return null;
	}
	let ratio = 1;
	let phase = 0;
	let heldLeft = 0;
	let heldRight = 0;
	node.onaudioprocess = (event) => {
		const output = event.outputBuffer;
		if (!output) return;
		const input = event.inputBuffer;
		const frames = output.length;
		const inputChannels = input.numberOfChannels;
		const outputChannels = output.numberOfChannels;
		const inLeft = input.getChannelData(0);
		const inRight = inputChannels > 1 ? input.getChannelData(1) : inLeft;
		const outLeft = output.getChannelData(0);
		const outRight = outputChannels > 1 ? output.getChannelData(1) : outLeft;
		for (let i = 0; i < frames; i++) {
			if (phase <= 0) {
				heldLeft = inLeft[i] ?? 0;
				heldRight = inRight[i] ?? 0;
				phase += ratio;
			}
			outLeft[i] = heldLeft;
			if (outputChannels > 1) outRight[i] = heldRight;
			phase -= 1;
		}
	};
	try {
		node.channelCount = 2;
		node.channelCountMode = 'explicit';
	} catch {
		// a minimal test double may not expose the AudioNode mixing properties
	}
	return {
		node,
		setRate(rate: number | undefined): void {
			ratio = rate === undefined ? 1 : Math.max(1, context.sampleRate / rate);
			phase = 0;
			heldLeft = 0;
			heldRight = 0;
		},
		dispose(): void {
			node.onaudioprocess = null;
			node.disconnect();
		},
	};
}

function buildCurve(preset: RetroEffectPreset): Float32Array<ArrayBuffer> | null {
	const bitValues = [preset.bitcrush?.bits, preset.dac?.bits].filter((value): value is number => value !== undefined);
	const bits = bitValues.length ? Math.min(...bitValues) : 0;
	const crossoverAmount = preset.dac?.crossover ?? 0;
	const drive = preset.bitcrush?.drive ?? 1;
	if (bits <= 0 && crossoverAmount <= 0 && drive <= 1) return null;
	const curve = new Float32Array(CURVE_POINTS);
	const normaliser = drive > 1 ? Math.tanh(drive) : 1;
	for (let i = 0; i < CURVE_POINTS; i++) {
		let value = -1 + (2 * i) / (CURVE_POINTS - 1);
		if (drive > 1) value = Math.tanh(value * drive) / normaliser;
		if (crossoverAmount > 0) value = crossover(value, crossoverAmount);
		if (bits > 0) value = quantize(value, bits);
		curve[i] = value;
	}
	return curve;
}

class Chain implements RetroEffectChain {
	readonly input: AudioNode;
	readonly output: AudioNode;
	readonly nodes: readonly AudioNode[];
	private readonly outputGain: GainNode;
	private readonly highpass: BiquadFilterNode;
	private readonly lowpass1: BiquadFilterNode;
	private readonly lowpass2: BiquadFilterNode;
	private readonly shaper: WaveShaperNode;
	private readonly decimator: Decimator | null;
	private readonly context: BaseAudioContext;
	private current: RetroEffectPreset;
	private currentStages: RetroEffectStage[];
	private currentOmitted: string[];
	private disposed = false;

	constructor(
		context: BaseAudioContext,
		preset: RetroEffectName | RetroEffectPreset,
		options: RetroEffectChainOptions = {},
	) {
		this.context = context;
		this.input = context.createGain();
		this.outputGain = context.createGain();
		this.output = this.outputGain;
		this.highpass = context.createBiquadFilter();
		this.highpass.type = 'highpass';
		this.lowpass1 = context.createBiquadFilter();
		this.lowpass1.type = 'lowpass';
		this.lowpass2 = context.createBiquadFilter();
		this.lowpass2.type = 'lowpass';
		this.shaper = context.createWaveShaper();
		this.shaper.oversample = 'none';
		this.decimator = createDecimator(context);

		const nodes: AudioNode[] = [this.input, this.highpass];
		if (this.decimator) nodes.push(this.decimator.node);
		nodes.push(this.shaper, this.lowpass1, this.lowpass2, this.outputGain);
		this.nodes = Object.freeze(nodes);

		if (options.connect !== false) {
			this.input.connect(this.highpass);
			let previous: AudioNode = this.highpass;
			if (this.decimator) {
				previous.connect(this.decimator.node);
				previous = this.decimator.node;
			}
			previous.connect(this.shaper);
			this.shaper.connect(this.lowpass1);
			this.lowpass1.connect(this.lowpass2);
			this.lowpass2.connect(this.output);
		}

		this.current = retroEffects(preset);
		this.currentStages = [];
		this.currentOmitted = [];
		this.apply(this.current);
	}

	get preset(): RetroEffectPreset {
		return this.current;
	}

	get stages(): readonly RetroEffectStage[] {
		return this.currentStages;
	}

	get omitted(): readonly string[] {
		return this.currentOmitted;
	}

	setPreset(preset: RetroEffectName | RetroEffectPreset): void {
		if (this.disposed) throw new Error('retro effect chain is disposed');
		this.current = retroEffects(preset);
		this.apply(this.current);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.decimator?.dispose();
		for (const node of this.nodes) node.disconnect();
	}

	private apply(preset: RetroEffectPreset): void {
		const now = this.context.currentTime;
		const highpass = preset.highpass;
		this.highpass.frequency.setValueAtTime(highpass?.frequency ?? 1, now);
		this.highpass.Q.setValueAtTime(highpass?.q ?? DEFAULT_Q, now);
		this.decimator?.setRate(preset.sampleRateReduction?.rate);
		this.shaper.curve = buildCurve(preset);
		const lowpass = preset.lowpass;
		const bypass = Math.min(this.context.sampleRate * 0.49, 20000);
		this.lowpass1.frequency.setValueAtTime(lowpass?.frequency ?? bypass, now);
		this.lowpass1.Q.setValueAtTime(lowpass?.q ?? DEFAULT_Q, now);
		this.lowpass2.frequency.setValueAtTime(lowpass && lowpass.order === 2 ? lowpass.frequency : bypass, now);
		this.lowpass2.Q.setValueAtTime(lowpass?.q ?? DEFAULT_Q, now);
		this.outputGain.gain.setValueAtTime(preset.gain ?? 1, now);
		this.currentStages = stagesOf(preset, this.decimator !== null);
		this.currentOmitted = preset.sampleRateReduction && !this.decimator ? ['sample-rate-reduction'] : [];
	}
}

function stagesOf(preset: RetroEffectPreset, hasDecimator: boolean): RetroEffectStage[] {
	const stages: RetroEffectStage[] = [];
	if (preset.highpass) stages.push('highpass');
	if (preset.sampleRateReduction && hasDecimator) stages.push('sample-rate-reduction');
	if (preset.bitcrush) stages.push('bitcrush');
	if (preset.dac) stages.push('dac');
	if (preset.lowpass) stages.push('lowpass');
	if (preset.gain !== undefined && preset.gain !== 1) stages.push('gain');
	return stages;
}

/**
 * Build a live retro effect chain for any Web Audio graph. The chain is fixed (high-pass,
 * sample-and-hold, bitcrush/DAC, low-pass, gain) and `setPreset` retunes it in place.
 *
 * @example
 * ```ts
 * const chain = createRetroEffectChain(context, 'nes');
 * source.connect(chain.input);
 * chain.output.connect(context.destination);
 * ```
 */
export function createRetroEffectChain(
	context: BaseAudioContext,
	preset: RetroEffectName | RetroEffectPreset,
	options: RetroEffectChainOptions = {},
): RetroEffectChain {
	return new Chain(context, preset, options);
}

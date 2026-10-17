/**
 * Layer 3 - audio driver and output: owns the Web Audio context, the master volume and the output filter.
 *
 * @example
 * ```ts
 * const driver = new AudioDriver();
 * await driver.init(); // call from a user gesture: browsers keep the context suspended until then
 * const voice = new PSGVoice(driver.getContext(), driver.getDestination());
 * ```
 */
export class AudioDriver {
	private ctx: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private outputFilter: BiquadFilterNode | null = null;

	public async init(): Promise<void> {
		if (this.ctx) return;

		const scope = globalThis as unknown as {
			AudioContext?: typeof AudioContext;
			webkitAudioContext?: typeof AudioContext;
		};
		const AudioContextClass = scope.AudioContext ?? scope.webkitAudioContext;
		if (!AudioContextClass) throw new Error('Web Audio API is not available in this environment.');
		this.ctx = new AudioContextClass();

		this.masterGain = this.ctx.createGain();
		this.masterGain.gain.setValueAtTime(0.2, this.ctx.currentTime);

		// output low-pass: softens the aliasing of raw square waves
		this.outputFilter = this.ctx.createBiquadFilter();
		this.outputFilter.type = 'lowpass';
		this.outputFilter.frequency.setValueAtTime(12000, this.ctx.currentTime); // 12 kHz

		this.masterGain.connect(this.outputFilter);
		this.outputFilter.connect(this.ctx.destination);

		if (this.ctx.state === 'suspended') {
			await this.ctx.resume();
		}
	}

	public getContext(): AudioContext {
		if (!this.ctx) throw new Error('AudioDriver is not initialised.');
		return this.ctx;
	}

	public getDestination(): GainNode {
		if (!this.masterGain) throw new Error('AudioDriver is not initialised.');
		return this.masterGain;
	}

	/** master volume, 0 to 1 (the default 0.2 leaves headroom for several voices) */
	public setMasterVolume(volume: number): void {
		if (!this.ctx || !this.masterGain) throw new Error('AudioDriver is not initialised.');
		this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), this.ctx.currentTime);
	}

	/** cut-off of the output low-pass in Hz */
	public setOutputCutoff(hz: number): void {
		if (!this.ctx || !this.outputFilter) throw new Error('AudioDriver is not initialised.');
		this.outputFilter.frequency.setValueAtTime(hz, this.ctx.currentTime);
	}

	/** closes the context and releases the nodes; `init()` can be called again afterwards */
	public async dispose(): Promise<void> {
		if (!this.ctx) return;
		this.masterGain?.disconnect();
		this.outputFilter?.disconnect();
		const ctx = this.ctx;
		this.ctx = null;
		this.masterGain = null;
		this.outputFilter = null;
		await ctx.close();
	}
}

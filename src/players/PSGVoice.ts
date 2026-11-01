/**
 * Layer 2 - one strict square-wave voice (Atari ST / AY-3-8910 style) made of a native oscillator and a gain,
 * without any analogue smoothing of its own: the output filter of the driver does that.
 */
export class PSGVoice {
	private ctx: AudioContext;
	private osc: OscillatorNode;
	private gainNode: GainNode;

	constructor(ctx: AudioContext, destination: AudioNode) {
		this.ctx = ctx;
		this.osc = this.ctx.createOscillator();
		this.osc.type = 'square';

		this.gainNode = this.ctx.createGain();
		this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);

		this.osc.connect(this.gainNode);
		this.gainNode.connect(destination);
		this.osc.start();
	}

	/** set the oscillator waveform (`square` unless a caller asks for a SID-style or test tone) */
	public setWaveform(type: OscillatorType): void {
		this.osc.type = type;
	}

	public setFrequency(hz: number, at: number = this.ctx.currentTime): void {
		this.osc.frequency.setValueAtTime(hz, at);
	}

	public setVolume(volume: number, at: number = this.ctx.currentTime): void {
		this.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), at);
	}

	public stop(at: number = this.ctx.currentTime): void {
		// drop any future note events of a scheduled sequence, or they would raise the gain again
		this.cancel(this.gainNode.gain, at);
		this.cancel(this.osc.frequency, at);
		this.gainNode.gain.setValueAtTime(0, at);
	}

	private cancel(param: AudioParam, at: number): void {
		const cancellable = param as AudioParam & { cancelScheduledValues?: (time: number) => void };
		cancellable.cancelScheduledValues?.(at);
	}

	public dispose(): void {
		this.osc.stop();
		this.osc.disconnect();
		this.gainNode.disconnect();
	}
}

/**
 * Layer 2 - one strict square-wave voice (Atari ST / AY-3-8910 style) made of a native oscillator and a gain,
 * without any analogue smoothing of its own: the output filter of the driver does that.
 */
export class PSGVoice {
	private ctx: AudioContext;
	private osc: OscillatorNode;
	private gainNode: GainNode;

	constructor(ctx: AudioContext, destination: GainNode) {
		this.ctx = ctx;
		this.osc = this.ctx.createOscillator();
		this.osc.type = 'square';

		this.gainNode = this.ctx.createGain();
		this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);

		this.osc.connect(this.gainNode);
		this.gainNode.connect(destination);
		this.osc.start();
	}

	public setFrequency(hz: number): void {
		this.osc.frequency.setValueAtTime(hz, this.ctx.currentTime);
	}

	public setVolume(volume: number): void {
		this.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), this.ctx.currentTime);
	}

	public stop(): void {
		this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
	}

	public dispose(): void {
		this.osc.stop();
		this.osc.disconnect();
		this.gainNode.disconnect();
	}
}

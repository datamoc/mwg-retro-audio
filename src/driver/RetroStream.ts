import type { RetroPlayer } from '../players/Player.ts';
import { OutputStage, type OutputStageOptions } from './OutputStage.ts';

export interface RetroStreamOptions {
	/** seconds of audio rendered per chunk (default 0.2) */
	chunkSeconds?: number;
	/** seconds of audio kept scheduled ahead of the clock (default 0.6) */
	lookaheadSeconds?: number;
	/** loop the tune when it ends (default false) */
	loop?: boolean;
	/** software output stage applied before Web Audio's own nodes */
	output?: OutputStageOptions;
}

/**
 * Plays a player through the native Web Audio API with no worklet or WebAssembly: audio is rendered a chunk at a
 * time on the main thread and scheduled as gapless `AudioBufferSourceNode`s a little ahead of the context clock.
 * The player must have been created with `sampleRate: context.sampleRate`.
 */
export class RetroStream {
	private timer: ReturnType<typeof setInterval> | null = null;
	private nextTime = 0;
	private sources = new Set<AudioBufferSourceNode>();
	private stage: OutputStage;
	private playing = false;
	private ending = false;
	private endTimer: ReturnType<typeof setTimeout> | null = null;
	/** called once, after the last scheduled chunk finished playing */
	onended: (() => void) | null = null;

	constructor(
		private readonly ctx: AudioContext,
		private readonly destination: AudioNode,
		readonly player: RetroPlayer,
		private readonly options: RetroStreamOptions = {},
	) {
		if (Math.abs(player.sampleRate - ctx.sampleRate) > 0.5) {
			throw new Error(
				`player sample rate ${player.sampleRate} Hz differs from the context rate ${ctx.sampleRate} Hz`,
			);
		}
		this.stage = new OutputStage(ctx.sampleRate, options.output ?? {});
		if (
			options.lookaheadSeconds !== undefined &&
			(!Number.isFinite(options.lookaheadSeconds) || options.lookaheadSeconds <= 0)
		) {
			throw new RangeError('lookaheadSeconds must be positive and finite');
		}
		if (
			options.chunkSeconds !== undefined &&
			(!Number.isFinite(options.chunkSeconds) || options.chunkSeconds <= 0)
		) {
			throw new RangeError('chunkSeconds must be positive and finite');
		}
	}

	/** repeat the tune when it ends: can be changed while playing */
	get loop(): boolean {
		return this.options.loop ?? false;
	}
	set loop(value: boolean) {
		this.options.loop = value;
	}

	get isPlaying(): boolean {
		return this.playing;
	}

	/** Start at an absolute AudioContext time; defaults to a short scheduling lead. */
	start(when = this.ctx.currentTime + 0.05): void {
		if (!Number.isFinite(when) || when < this.ctx.currentTime)
			throw new RangeError('Start time must not be in the past');
		if (this.playing) return;
		this.playing = true;
		this.ending = false;
		this.nextTime = when;
		this.pump();
		const every = Math.max(20, (this.options.chunkSeconds ?? 0.2) * 500);
		this.timer = setInterval(() => this.pump(), every);
	}

	stop(): void {
		this.playing = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.endTimer !== null) clearTimeout(this.endTimer);
		this.endTimer = null;
		for (const s of this.sources) {
			try {
				s.stop();
			} catch {
				// already stopped
			}
			s.disconnect();
		}
		this.sources.clear();
	}

	private pump(): void {
		const ahead = this.options.lookaheadSeconds ?? 0.6;
		const chunk = Math.max(256, Math.floor((this.options.chunkSeconds ?? 0.2) * this.ctx.sampleRate));
		while (this.playing && !this.ending && this.nextTime < this.ctx.currentTime + ahead) {
			const l = new Float32Array(chunk);
			const r = new Float32Array(chunk);
			let got = this.player.render(l, r, 0, chunk);
			if (got < chunk && this.options.loop) {
				this.player.reset();
				got += this.player.render(l, r, got, chunk - got);
			}
			if (got > 0) {
				this.stage.process(l, r, 0, got);
				this.schedule(l, r, got);
			}
			if (got < chunk) {
				this.ending = true;
				const wait = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000) + 30;
				this.endTimer = setTimeout(() => {
					this.endTimer = null;
					if (this.playing) {
						this.stop();
						this.onended?.();
					}
				}, wait);
			}
		}
	}

	private schedule(l: Float32Array, r: Float32Array, frames: number): void {
		const buffer = this.ctx.createBuffer(2, frames, this.ctx.sampleRate);
		buffer.copyToChannel(l.subarray(0, frames) as Float32Array<ArrayBuffer>, 0);
		buffer.copyToChannel(r.subarray(0, frames) as Float32Array<ArrayBuffer>, 1);
		const src = this.ctx.createBufferSource();
		src.buffer = buffer;
		src.connect(this.destination);
		src.onended = () => {
			this.sources.delete(src);
			src.disconnect();
		};
		const when = Math.max(this.nextTime, this.ctx.currentTime);
		src.start(when);
		this.sources.add(src);
		this.nextTime = when + frames / this.ctx.sampleRate;
	}
}

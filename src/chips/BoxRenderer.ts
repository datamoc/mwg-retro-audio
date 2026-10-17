/**
 * Helper shared by the chips that are stepped at a fixed internal rate faster than the output rate (YM2149, SN76489,
 * NES APU, SID): every output sample is the exact average of the internal steps it covers, which is a box filter
 * and keeps the aliasing of square waves low without oversampling buffers.
 */
export abstract class BoxRenderer {
	/** instantaneous output of the last step, set by `step()` */
	protected curL = 0;
	protected curR = 0;
	private tickLeft = 0;

	/** @param ticksPerSample internal steps per output sample (may be fractional) */
	constructor(protected readonly ticksPerSample: number) {}

	/** advance the chip by one internal step and update `curL` / `curR` */
	protected abstract step(): void;

	protected resetBox(): void {
		this.tickLeft = 0;
		this.curL = this.curR = 0;
	}

	/** optional per-sample post-processing hook (filters); receives the averaged sample and returns the output */
	protected post(l: number, r: number, out: [number, number]): void {
		out[0] = l;
		out[1] = r;
	}

	private readonly tmp: [number, number] = [0, 0];

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		const tps = this.ticksPerSample;
		for (let i = 0; i < count; i++) {
			let need = tps;
			let accL = 0;
			let accR = 0;
			while (need > 1e-9) {
				if (this.tickLeft <= 1e-9) {
					this.step();
					this.tickLeft = 1;
				}
				const take = Math.min(need, this.tickLeft);
				accL += this.curL * take;
				accR += this.curR * take;
				need -= take;
				this.tickLeft -= take;
			}
			this.post(accL / tps, accR / tps, this.tmp);
			left[start + i] += this.tmp[0];
			right[start + i] += this.tmp[1];
		}
	}
}

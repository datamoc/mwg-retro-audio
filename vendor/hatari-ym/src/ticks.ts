import { HatariYm, type HatariYmOptions } from './ym2149.ts';

export interface TickRenderOptions extends HatariYmOptions {
	/** driver interrupt rate in Hz (Airball: MFP timer D, 245.76 Hz) */
	tickHz?: number;
	/** CPU cycles between two register writes of the driver (Airball: 60 = move.b + move.b) */
	writeSpacing?: number;
	/** registers written by the driver at each tick, in order (Airball: 10 down to 0) */
	registerOrder?: number[];
	/** CPU clock of the first tick */
	startClock?: number;
}

/**
 * Render a stream of register snapshots (one per driver interrupt, as produced by a software sound driver)
 * through the Hatari sound chain.  Each snapshot is written register by register, like an interrupt routine
 * would, `writeSpacing` CPU cycles apart.  Timing inside the tick is an approximation of the real code (the
 * real write instants of a given program can be captured with Hatari's `--trace psg_write`), everything
 * downstream of the register writes is exact.
 */
export function renderRegisterFrames(frames: ArrayLike<ArrayLike<number>>, opts: TickRenderOptions = {}): Int16Array {
	const ym = new HatariYm(opts);
	const tickHz = opts.tickHz ?? 245.76;
	const spacing = opts.writeSpacing ?? 60;
	const order = opts.registerOrder ?? [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
	const start = opts.startClock ?? Math.round(ym.cpuFreq * 0.5);
	ym.reset(0);
	for (let i = 0; i < frames.length; i++) {
		const base = start + Math.round((i * ym.cpuFreq) / tickHz);
		let k = 0;
		for (const reg of order) ym.writeData(base + k++ * spacing, reg, frames[i][reg] ?? 0);
	}
	ym.update(start + Math.round((frames.length * ym.cpuFreq) / tickHz));
	return ym.takeSamples();
}

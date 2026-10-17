import { HatariYm, type HatariYmOptions } from './ym2149.ts';
import { HATARI_TRACE_ORIGIN, type TraceData } from './trace.ts';

export interface RenderOptions extends HatariYmOptions {
	/** constant added to every trace clock (offset of FrameCycles against the global CPU clock) */
	origin?: number;
	/** added to every write: clock += instrScale * CurrentInstrCycles + instrOffset (write-access position inside the instruction) */
	instrScale?: number;
	instrOffset?: number;
	/**
	 * CPU frequency of the machine that produced the trace.  When it differs from the synthesizer's machine the
	 * clocks are rescaled so that every write keeps its wall-clock time (what a program driven by a fixed-rate
	 * timer, like the MFP, would do on the other machine).  Default: same machine, no rescaling.
	 */
	traceCpuFreq?: number;
	/** first VBL after which the samples are no longer wanted */
	untilVbl?: number;
}

/**
 * Replay a Hatari trace through the synthesizer.  Like Hatari, samples are generated up to each register
 * write (Sound_Update in PSG_Set_DataRegister) and up to the end of every VBL (Sound_Update_VBL).
 */
export function renderTrace(trace: TraceData, opts: RenderOptions = {}): Int16Array {
	const origin = opts.origin ?? HATARI_TRACE_ORIGIN;
	const ym = new HatariYm(opts);
	const k = ym.cpuFreq / (opts.traceCpuFreq ?? ym.cpuFreq);
	const at = (clock: number): number => (k === 1 ? origin + clock : Math.round(clock * k) + origin);
	ym.reset(0);                                              // Sound_Init() happens at CyclesGlobalClockCounter = 0
	let vbl = 0;
	for (const e of trace.events) {
		while (vbl < e.vbl) {                                   // VBL handler: Sound_Update_VBL()
			vbl++;
			ym.update(at(trace.frameStart[vbl]));
		}
		if (opts.untilVbl !== undefined && e.vbl > opts.untilVbl) break;
		const clock = at(e.clock + (opts.instrScale ?? 0) * e.instr) + (opts.instrOffset ?? 0);
		if (e.kind === 'r') ym.psgReset();
		else ym.writeData(clock, e.reg, e.value);
	}
	const last = trace.frameStart.length - 1;                   // final Sound_Update_VBL()
	if (opts.untilVbl === undefined) ym.update(at(trace.frameStart[last]));
	return ym.takeSamples();
}

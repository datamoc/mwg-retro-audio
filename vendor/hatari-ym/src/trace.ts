/**
 * Reader for the traces produced by `hatari --trace psg_write,video_vbl`.
 *
 * Every write to a YM register is logged with the frame-relative cycle counter (FrameCycles), and every VBL
 * with the length in CPU cycles of the frame that just ended.  The global CPU clock of an event is therefore
 *     clock = origin + sum(length of all frames ended before the event) + FrameCycles
 * `origin` is the (unknown, constant) offset between FrameCycles and CyclesGlobalClockCounter.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Constant to add to `frameStart + FrameCycles` to obtain the global CPU clock used by Hatari's sound code
 * (Cycles_GetClockCounterOnWriteAccess).  Calibrated once on Hatari 2.5.0 (STF, EmuTOS): with this value the
 * synthesizer reproduces the recorded audio sample for sample over 25 minutes of recordings.
 */
export const HATARI_TRACE_ORIGIN = -44;

export interface YmEvent {
	/** global CPU clock of the write, without the origin offset */
	clock: number;
	/** 'w' = register write, 'r' = PSG reset */
	kind: 'w' | 'r';
	reg: number;
	value: number;
	vbl: number;
	/** CurrentInstrCycles of the writing instruction */
	instr: number;
}

export interface TraceData {
	events: YmEvent[];
	/** clock (without origin) at the start of every frame; index = VBL number */
	frameStart: number[];
	frameLength: number[];
}

const RE_VBL = /^VBL (\d+) video_cyc=(\d+) pending_cyc=(\d+) vbl_cycles=(\d+)/;
const RE_WRITE = /^ym write data reg=0x([0-9a-f]+) val=0x([0-9a-f]+) video_cyc=(\d+).*instr_cycle (\d+)/;
const RE_RESET = /^ym reset video_cyc=(\d+)/;

export async function readTrace(path: string, maxVbl = Infinity): Promise<TraceData> {
	const events: YmEvent[] = [];
	const frameStart: number[] = [0];
	const frameLength: number[] = [0];
	let vbl = 0;
	const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
	for await (const line of rl) {
		const c = line.charCodeAt(0);
		if (c === 86 /* V */) {
			const m = RE_VBL.exec(line);
			if (m) {
				vbl = Number(m[1]);
				const len = Number(m[4]);
				frameLength[vbl] = len;
				frameStart[vbl] = (frameStart[vbl - 1] ?? 0) + len;
				if (vbl > maxVbl) break;
			}
		} else if (c === 121 /* y */) {
			let m = RE_WRITE.exec(line);
			if (m) {
				events.push({ clock: frameStart[vbl] + Number(m[3]), kind: 'w', reg: parseInt(m[1], 16), value: parseInt(m[2], 16), vbl, instr: Number(m[4]) });
				continue;
			}
			m = RE_RESET.exec(line);
			if (m) events.push({ clock: frameStart[vbl] + Number(m[1]), kind: 'r', reg: 0, value: 0, vbl, instr: 0 });
		}
	}
	return { events, frameStart, frameLength };
}

import type { MidiEvent } from './midi.ts';

export interface WriteSmfOptions {
	/** ticks per quarter note (default 480) */
	ticksPerQuarter?: number;
	/** tempo in microseconds per quarter note (default 500000, 120 beats a minute) */
	tempo?: number;
	/** track name */
	title?: string;
}

const MAX_DELTA = 0x0fffffff;

function vlq(value: number): number[] {
	const bytes = [value & 0x7f];
	for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
	return bytes;
}

/**
 * Write timed channel messages as a format 0 Standard MIDI File, the inverse of `parseSmf`: a recording made at a
 * keyboard becomes a file any sequencer opens. `time` is in seconds, the order of events with the same time is kept.
 * Only channel voice messages (status 0x80-0xEF) are written; anything else is a mistake and throws.
 */
export function writeSmf(events: readonly MidiEvent[], options: WriteSmfOptions = {}): Uint8Array<ArrayBuffer> {
	const ticksPerQuarter = options.ticksPerQuarter ?? 480;
	const tempo = options.tempo ?? 500000;
	if (!Number.isInteger(ticksPerQuarter) || ticksPerQuarter < 1 || ticksPerQuarter > 0x7fff)
		throw new RangeError('ticksPerQuarter must be an integer from 1 to 32767');
	if (!Number.isInteger(tempo) || tempo < 1 || tempo > 0xffffff)
		throw new RangeError('tempo must be an integer from 1 to 16777215 microseconds per quarter note');
	for (const event of events) {
		if (!Number.isFinite(event.time) || event.time < 0)
			throw new RangeError('event time must be a finite number of seconds');
		if (event.status < 0x80 || event.status > 0xef)
			throw new RangeError(`not a channel message: status ${event.status}`);
	}
	const body: number[] = [0, 0xff, 0x51, 3, tempo >> 16, (tempo >> 8) & 255, tempo & 255];
	if (options.title) {
		const text = [...new TextEncoder().encode(options.title)];
		body.push(0, 0xff, 0x03, ...vlq(text.length), ...text);
	}
	const toTicks = (seconds: number): number => Math.round((seconds * 1e6 * ticksPerQuarter) / tempo);
	let last = 0;
	for (const event of [...events].sort((a, b) => a.time - b.time)) {
		const tick = toTicks(event.time);
		if (tick - last > MAX_DELTA) throw new RangeError('a gap between two events is too long for a MIDI file');
		body.push(...vlq(tick - last), event.status, event.data1 & 0x7f);
		const kind = event.status >> 4;
		if (kind !== 0xc && kind !== 0xd) body.push(event.data2 & 0x7f);
		last = tick;
	}
	body.push(0, 0xff, 0x2f, 0);
	const file = new Uint8Array(14 + 8 + body.length);
	const view = new DataView(file.buffer);
	file.set([0x4d, 0x54, 0x68, 0x64], 0); // MThd
	view.setUint32(4, 6);
	view.setUint16(8, 0); // format 0
	view.setUint16(10, 1); // one track
	view.setUint16(12, ticksPerQuarter);
	file.set([0x4d, 0x54, 0x72, 0x6b], 14); // MTrk
	view.setUint32(18, body.length);
	file.set(body, 22);
	return file;
}

import type { Chip, ChipOptions } from '../chips/Chip.ts';
import { createChip } from '../chips/index.ts';
import { Region, regionFromFrameRate } from '../region.ts';
import type { PlayerInfo, RetroPlayer } from '../players/Player.ts';
import { deflateRaw, deflateStored, inflateRaw } from './inflate.ts';

/**
 * MWA ("MW Audio"): the universal, compact, dependency-free container of this engine.
 *
 * Any retro music or sound effect is, at bottom, a timed list of register writes to one or more chips. MWA stores
 * exactly that, whatever the source format (YM, VGM, NSF, SID, tracker, DRO...), so a game only needs the one
 * player below. The file is the 5 byte header + a DEFLATE-compressed payload (decoded here without any library).
 * See docs/MWA.md for the byte-level specification.
 */

export const MWA_MAGIC = 'MWA1';

export interface MwaChipSpec {
	/** chip id of the registry: 'ym2149', 'ay8910', 'sn76489', 'nes-apu', 'sid', 'opl2', 'opl3', 'ym2612' */
	id: string;
	clock: number;
	/** chip specific constructor options (model, variant, ...) */
	options?: Record<string, unknown>;
}

export interface MwaBlob {
	chip: number;
	/** address in the chip's memory space (NES DPCM samples live at $C000-$FFFF) */
	address: number;
	data: Uint8Array;
}

export interface MwaData {
	/** time unit of the events, ticks per second (default 44100: one tick = one sample at CD rate) */
	timebase: number;
	/** frames per second of the original player: 50 / 60 (or exact 50.1245... for a C64) */
	frameRate: number;
	title: string;
	author: string;
	comment: string;
	chips: MwaChipSpec[];
	/** event times in ticks, non-decreasing */
	time: Float64Array;
	chip: Uint8Array;
	addr: Uint16Array;
	value: Uint8Array;
	/** total length in ticks (silence after the last write is kept) */
	length: number;
	/** loop start in ticks, or -1 for no loop */
	loopStart: number;
	blobs: MwaBlob[];
}

class Writer {
	private buf = new Uint8Array(1024);
	private len = 0;
	private grow(n: number): void {
		if (this.len + n <= this.buf.length) return;
		const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
		b.set(this.buf.subarray(0, this.len));
		this.buf = b;
	}
	u8(v: number): void {
		this.grow(1);
		this.buf[this.len++] = v & 255;
	}
	varint(v: number): void {
		let n = Math.max(0, Math.floor(v));
		while (n >= 128) {
			this.u8((n % 128) | 128);
			n = Math.floor(n / 128);
		}
		this.u8(n);
	}
	f64(v: number): void {
		this.grow(8);
		new DataView(this.buf.buffer).setFloat64(this.len, v, true);
		this.len += 8;
	}
	bytes(b: Uint8Array): void {
		this.grow(b.length);
		this.buf.set(b, this.len);
		this.len += b.length;
	}
	string(s: string): void {
		const b = new TextEncoder().encode(s);
		this.varint(b.length);
		this.bytes(b);
	}
	result(): Uint8Array {
		return this.buf.slice(0, this.len);
	}
}

class Reader {
	pos = 0;
	constructor(readonly data: Uint8Array) {}
	u8(): number {
		if (this.pos >= this.data.length) throw new Error('MWA: unexpected end of data');
		return this.data[this.pos++];
	}
	varint(): number {
		let v = 0;
		let mul = 1;
		for (;;) {
			const b = this.u8();
			v += (b & 127) * mul;
			if (!(b & 128)) return v;
			mul *= 128;
			if (mul > 2 ** 56) throw new Error('MWA: bad varint');
		}
	}
	f64(): number {
		if (this.pos + 8 > this.data.length) throw new Error('MWA: unexpected end of data');
		const v = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8).getFloat64(0, true);
		this.pos += 8;
		return v;
	}
	bytes(n: number): Uint8Array {
		if (this.pos + n > this.data.length) throw new Error('MWA: unexpected end of data');
		const b = this.data.subarray(this.pos, this.pos + n);
		this.pos += n;
		return b;
	}
	string(): string {
		return new TextDecoder().decode(this.bytes(this.varint()));
	}
}

function serializePayload(d: MwaData): Uint8Array {
	const w = new Writer();
	w.f64(d.timebase);
	w.f64(d.frameRate);
	w.string(d.title);
	w.string(d.author);
	w.string(d.comment);
	w.varint(d.chips.length);
	for (const c of d.chips) {
		w.string(c.id);
		w.f64(c.clock);
		w.string(c.options && Object.keys(c.options).length ? JSON.stringify(c.options) : '');
	}
	w.varint(d.blobs.length);
	for (const b of d.blobs) {
		w.varint(b.chip);
		w.varint(b.address);
		w.varint(b.data.length);
		w.bytes(b.data);
	}
	w.varint(d.length);
	w.varint(d.loopStart + 1);
	w.varint(d.time.length);
	let prev = 0;
	for (let i = 0; i < d.time.length; i++) {
		const t = Math.round(d.time[i]);
		w.varint(t - prev);
		prev = t;
		w.u8(d.chip[i]);
		w.varint(d.addr[i]);
		w.u8(d.value[i]);
	}
	return w.result();
}

function parsePayload(payload: Uint8Array): MwaData {
	const r = new Reader(payload);
	const timebase = r.f64();
	const frameRate = r.f64();
	const title = r.string();
	const author = r.string();
	const comment = r.string();
	const chips: MwaChipSpec[] = [];
	for (let n = r.varint(); n > 0; n--) {
		const id = r.string();
		const clock = r.f64();
		const opts = r.string();
		chips.push({ id, clock, options: opts ? (JSON.parse(opts) as Record<string, unknown>) : undefined });
	}
	const blobs: MwaBlob[] = [];
	for (let n = r.varint(); n > 0; n--) {
		const chip = r.varint();
		const address = r.varint();
		const len = r.varint();
		blobs.push({ chip, address, data: r.bytes(len).slice() });
	}
	const length = r.varint();
	const loopStart = r.varint() - 1;
	const count = r.varint();
	const time = new Float64Array(count);
	const chip = new Uint8Array(count);
	const addr = new Uint16Array(count);
	const value = new Uint8Array(count);
	let t = 0;
	for (let i = 0; i < count; i++) {
		t += r.varint();
		time[i] = t;
		chip[i] = r.u8();
		addr[i] = r.varint();
		value[i] = r.u8();
	}
	return { timebase, frameRate, title, author, comment, chips, time, chip, addr, value, length, loopStart, blobs };
}

/** true when the bytes start with the MWA magic */
export function isMwa(bytes: Uint8Array): boolean {
	return bytes.length >= 9 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === MWA_MAGIC;
}

function frame(payload: Uint8Array, packed: Uint8Array, compressed: boolean): Uint8Array {
	const out = new Uint8Array(9 + packed.length);
	for (let i = 0; i < 4; i++) out[i] = MWA_MAGIC.charCodeAt(i);
	out[4] = compressed ? 1 : 0;
	new DataView(out.buffer).setUint32(5, payload.length, true);
	out.set(packed, 9);
	return out;
}

/** Encode with the platform's native compressor (falls back to stored blocks when there is none) */
export async function encodeMwa(data: MwaData): Promise<Uint8Array> {
	const payload = serializePayload(data);
	return frame(payload, await deflateRaw(payload), true);
}

/** Synchronous encoding without compression (valid MWA, larger) */
export function encodeMwaUncompressed(data: MwaData): Uint8Array {
	const payload = serializePayload(data);
	return frame(payload, deflateStored(payload), true);
}

/** Decode an MWA file (synchronous, no external dependency) */
export function decodeMwa(bytes: Uint8Array): MwaData {
	if (!isMwa(bytes)) throw new Error('not an MWA file');
	const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5, true);
	const payload = bytes[4] & 1 ? inflateRaw(bytes, 9, size) : bytes.subarray(9, 9 + size);
	return parsePayload(payload);
}

/** Options common to every loader: the sample rate and an optional chip factory (how recording hooks in) */
/**
 * Where an emulated program's instructions are counted: `spend(count)` throws once the allowance is used up.
 * mwg's `InstructionBudget` (`@datamoc/mwg/audio`) has this shape; nothing here imports it.
 */
export interface InstructionSpender {
	spend(count?: number): void;
}

export interface LoadOptions {
	/** output sample rate in Hz (default 44100) */
	sampleRate?: number;
	/** build the chips: defaults to the registry; `MwaRecorder.factory` records what the player writes */
	chipFactory?: (id: string, options: ChipOptions & Record<string, unknown>) => Chip;
	/** loop the music at its loop point instead of ending (default false) */
	loop?: boolean;
	/**
	 * counts the instructions an emulated program (NSF, PSID, SPC) runs while it plays, so a hostile or
	 * broken file fails by name instead of rendering slower than real time; unlimited when omitted
	 */
	budget?: InstructionSpender;
}

/** Plays an MWA file: the timed register writes drive the chips, which render the audio */
export class MwaPlayer implements RetroPlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[] = [];
	readonly sampleRate: number;
	private readonly data: MwaData;
	private readonly loop: boolean;
	private idx = 0;
	private pos = 0; // output samples rendered
	private offsetTicks = 0;
	private loopIdx = -1;
	private ended = false;

	constructor(data: MwaData | Uint8Array, options: LoadOptions = {}) {
		this.data = data instanceof Uint8Array ? decodeMwa(data) : data;
		this.sampleRate = options.sampleRate ?? 44100;
		this.loop = options.loop ?? false;
		const factory = options.chipFactory ?? createChip;
		const d = this.data;
		const memories = d.chips.map(() => new Uint8Array(0x10000));
		for (const b of d.blobs) memories[b.chip]?.set(b.data, b.address);
		d.chips.forEach((spec, i) => {
			const extra: Record<string, unknown> = { ...(spec.options ?? {}) };
			if (spec.id === 'nes-apu') extra.readMemory = (a: number): number => memories[i][a & 0xffff];
			this.chips.push(factory(spec.id, { ...extra, sampleRate: this.sampleRate, clock: spec.clock }));
		});
		this.info = {
			format: 'mwa',
			title: d.title || undefined,
			author: d.author || undefined,
			comment: d.comment || undefined,
			chips: d.chips.map((c) => c.id),
			region: regionFromFrameRate(d.frameRate) as Region,
			frameRate: d.frameRate,
			durationSeconds: d.length / d.timebase,
			loopStartSeconds: d.loopStart >= 0 ? d.loopStart / d.timebase : undefined,
		};
		if (d.loopStart >= 0) {
			this.loopIdx = 0;
			while (this.loopIdx < d.time.length && d.time[this.loopIdx] < d.loopStart) this.loopIdx++;
		}
	}

	get finished(): boolean {
		return this.ended;
	}

	reset(): void {
		for (const c of this.chips) c.reset();
		this.idx = 0;
		this.pos = 0;
		this.offsetTicks = 0;
		this.ended = false;
	}

	private samplesAt(ticks: number): number {
		return Math.round(this.exactAt(ticks));
	}

	/** the exact (fractional) output sample of a time in ticks */
	private exactAt(ticks: number): number {
		return ((ticks + this.offsetTicks) * this.sampleRate) / this.data.timebase;
	}

	/** the sample a write lands on: chips with `writeAt` keep the fraction, the others use the nearest sample */
	private eventSample(i: number): number {
		const exact = this.exactAt(this.data.time[i]);
		return this.chips[this.data.chip[i]]?.writeAt ? Math.floor(exact) : Math.round(exact);
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): number {
		const d = this.data;
		let done = 0;
		while (done < count && !this.ended) {
			// apply the writes that are due
			while (this.idx < d.time.length && this.eventSample(this.idx) <= this.pos) {
				const chip = this.chips[d.chip[this.idx]];
				if (chip?.writeAt)
					chip.writeAt(
						Math.max(0, this.exactAt(d.time[this.idx]) - this.pos),
						d.addr[this.idx],
						d.value[this.idx],
					);
				else chip?.write(d.addr[this.idx], d.value[this.idx]);
				this.idx++;
			}
			const endSample = this.samplesAt(d.length);
			if (this.idx >= d.time.length && this.pos >= endSample) {
				if (this.loop && this.loopIdx >= 0 && d.length > d.loopStart) {
					this.offsetTicks += d.length - d.loopStart;
					this.idx = this.loopIdx;
					continue;
				}
				this.ended = true;
				break;
			}
			const next = this.idx < d.time.length ? Math.min(this.eventSample(this.idx), endSample) : endSample;
			const n = Math.min(count - done, Math.max(1, next - this.pos));
			for (const c of this.chips) c.render(left, right, start + done, n);
			this.pos += n;
			done += n;
		}
		return done;
	}

	setMuted(chipIndex: number, channel: number, muted: boolean): void {
		this.chips[chipIndex]?.setMuted(channel, muted);
	}
}

/** A chip that forwards everything to `inner` and logs the register writes with the audio time they happen at */
export class RecordingChip implements Chip {
	readonly id: string;
	readonly name: string;
	readonly channels: number;
	readonly clock: number;
	readonly sampleRate: number;
	/** frames rendered so far: the time of a write is the number of frames rendered before it */
	frames = 0;

	constructor(
		readonly inner: Chip,
		private readonly onWrite: (chipFrames: number, addr: number, value: number) => void,
	) {
		this.id = inner.id;
		this.name = inner.name;
		this.channels = inner.channels;
		this.clock = inner.clock;
		this.sampleRate = inner.sampleRate;
		if (inner.writeAt) {
			// keep the fractional position of the write: the log time is a fractional number of frames
			this.writeAt = (offset, addr, value): void => {
				this.onWrite(this.frames + offset, addr, value);
				inner.writeAt!(offset, addr, value);
			};
		}
	}

	writeAt?: (offset: number, addr: number, value: number) => void;

	reset(): void {
		this.frames = 0;
		this.inner.reset();
	}
	write(addr: number, value: number): void {
		this.onWrite(this.frames, addr, value);
		this.inner.write(addr, value);
	}
	read(addr: number): number {
		return this.inner.read(addr);
	}
	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.inner.render(left, right, start, count);
		this.frames += count;
	}
	setMuted(channel: number, muted: boolean): void {
		this.inner.setMuted(channel, muted);
	}
}

/**
 * Records the register writes of any player into MWA: build the player with `chipFactory: recorder.factory`, render
 * it (`renderPlayer`), then call `finish()`. This is how every supported format converts to MWA.
 */
export class MwaRecorder {
	private readonly specs: MwaChipSpec[] = [];
	private readonly recs: RecordingChip[] = [];
	private time: number[] = [];
	private chipIdx: number[] = [];
	private addr: number[] = [];
	private value: number[] = [];
	private readonly timebase: number;

	constructor(options: { timebase?: number } = {}) {
		this.timebase = options.timebase ?? 44100;
	}

	/** chip factory to give to a loader */
	readonly factory = (id: string, options: ChipOptions & Record<string, unknown>): Chip => {
		const { sampleRate, clock, ...rest } = options;
		const inner = createChip(id, options);
		const index = this.specs.length;
		const extras: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(rest)) if (typeof v !== 'function') extras[k] = v;
		this.specs.push({ id, clock: clock ?? inner.clock, options: extras });
		const rate = sampleRate ?? inner.sampleRate;
		const rec = new RecordingChip(inner, (frames, addr, value) => {
			this.time.push((frames * this.timebase) / rate);
			this.chipIdx.push(index);
			this.addr.push(addr);
			this.value.push(value);
		});
		this.recs.push(rec);
		return rec;
	};

	/** build the MWA data; `seconds` is the total length rendered (including the silence at the end) */
	finish(info: {
		frameRate: number;
		title?: string;
		author?: string;
		comment?: string;
		loopStartSeconds?: number;
	}): MwaData {
		const order = this.time.map((_, i) => i).sort((a, b) => this.time[a] - this.time[b] || a - b);
		const frames = Math.max(0, ...this.recs.map((r) => r.frames));
		const rate = this.recs[0]?.sampleRate ?? 44100;
		return {
			timebase: this.timebase,
			frameRate: info.frameRate,
			title: info.title ?? '',
			author: info.author ?? '',
			comment: info.comment ?? '',
			chips: this.specs,
			time: Float64Array.from(order, (i) => this.time[i]),
			chip: Uint8Array.from(order, (i) => this.chipIdx[i]),
			addr: Uint16Array.from(order, (i) => this.addr[i]),
			value: Uint8Array.from(order, (i) => this.value[i]),
			length: Math.round((frames * this.timebase) / rate),
			loopStart: info.loopStartSeconds === undefined ? -1 : Math.round(info.loopStartSeconds * this.timebase),
			blobs: [],
		};
	}
}

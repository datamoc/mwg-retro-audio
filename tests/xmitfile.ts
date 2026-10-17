/** builders of tiny XM and IT modules for tests */

export interface XmCell {
	note?: number;
	instrument?: number;
	volume?: number;
	effect?: number;
	param?: number;
}

const ascii = (s: string, n: number): number[] => [...s.padEnd(n, '\0').slice(0, n)].map((c) => c.charCodeAt(0));
const u16 = (v: number): number[] => [v & 255, (v >> 8) & 255];
const u32 = (v: number): number[] => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

export function buildXm(opts: {
	rows: XmCell[][]; // rows[row][channel], one pattern
	channels?: number;
	linear?: boolean;
	sample?: Int8Array;
	loop?: boolean;
	relativeNote?: number;
	finetune?: number;
	sampleVolume?: number;
	volEnv?: { points: [number, number][]; flags: number; sustain?: number };
	fadeout?: number;
	speed?: number;
	bpm?: number;
	patternRows?: number;
}): Uint8Array {
	const channels = opts.channels ?? 2;
	const sample = opts.sample ?? Int8Array.from({ length: 32 }, (_, i) => (i < 16 ? 100 : -100));
	const patRows = opts.patternRows ?? 64;
	const out: number[] = [...ascii('Extended Module: ', 17), ...ascii('test', 20), 0x1a, ...ascii('tester', 20), 4, 1];
	out.push(
		...u32(276),
		...u16(1),
		...u16(0),
		...u16(channels),
		...u16(1),
		...u16(1),
		...u16(opts.linear === false ? 0 : 1),
		...u16(opts.speed ?? 6),
		...u16(opts.bpm ?? 125),
	);
	out.push(0, ...new Array(255).fill(0));
	// pattern (uncompressed layout)
	const data: number[] = [];
	for (let r = 0; r < patRows; r++) {
		for (let c = 0; c < channels; c++) {
			const cell = opts.rows[r]?.[c] ?? {};
			data.push(cell.note ?? 0, cell.instrument ?? 0, cell.volume ?? 0, cell.effect ?? 0, cell.param ?? 0);
		}
	}
	out.push(...u32(9), 0, ...u16(patRows), ...u16(data.length), ...data);
	// instrument
	out.push(...u32(263), ...ascii('inst', 22), 0, ...u16(1), ...u32(40));
	out.push(...new Array(96).fill(0));
	const env = opts.volEnv;
	const pts = new Array<number>(48).fill(0);
	env?.points.forEach(([t, v], i) => pts.splice(i * 4, 4, ...u16(t), ...u16(v)));
	out.push(...pts, ...new Array(48).fill(0));
	out.push(env?.points.length ?? 0, 0, env?.sustain ?? 0, 0, 0, 0, 0, 0, env?.flags ?? 0, 0, 0, 0, 0, 0);
	out.push(...u16(opts.fadeout ?? 0), ...new Array(22).fill(0));
	// sample header
	const loopLen = opts.loop === false ? 0 : sample.length;
	out.push(
		...u32(sample.length),
		...u32(0),
		...u32(loopLen),
		opts.sampleVolume ?? 64,
		(opts.finetune ?? 0) & 255,
		loopLen ? 1 : 0,
		128,
		(opts.relativeNote ?? 0) & 255,
		0,
		...ascii('smp', 22),
	);
	// delta coded data
	let prev = 0;
	for (const v of sample) {
		out.push((v - prev) & 255);
		prev = v;
	}
	return Uint8Array.from(out);
}

export interface ItCell {
	channel?: number;
	note?: number; // IT note 0-119
	instrument?: number;
	volume?: number;
	command?: number; // 1 = A
	param?: number;
}

export function buildIt(opts: {
	rows: ItCell[][];
	patternRows?: number;
	sample?: Int8Array;
	c5speed?: number;
	speed?: number;
	tempo?: number;
	/** raw bytes stored for the sample instead of the plain data (compressed samples) */
	sampleBytes?: number[];
	/** flags byte of the sample header (default 1 | 16: present, looped) */
	sampleFlags?: number;
	/** convert byte of the sample header (bit 0 signed, bit 2 IT215) */
	cvt?: number;
	/** compatible-with version of the file header (0x214, or 0x215 for IT215 compression) */
	cmwt?: number;
}): Uint8Array {
	const sample = opts.sample ?? Int8Array.from({ length: 32 }, (_, i) => (i < 16 ? 100 : -100));
	const rows = opts.patternRows ?? 64;
	const headerEnd = 0xc0 + 1 + 4 + 4; // orders(1) + 1 sample offset + 1 pattern offset
	const sampleOffset = headerEnd;
	const dataOffset = sampleOffset + 0x50;
	const stored = opts.sampleBytes ?? Array.from(sample, (v) => v & 255);
	const patOffset = dataOffset + stored.length;
	// pattern: each row lists its cells then a 0 end-of-row byte
	const pat: number[] = [];
	for (let r = 0; r < rows; r++) {
		for (const cell of opts.rows[r] ?? []) {
			const ch = cell.channel ?? 0;
			let mask = 0;
			const body: number[] = [];
			if (cell.note !== undefined) {
				mask |= 1;
				body.push(cell.note);
			}
			if (cell.instrument !== undefined) {
				mask |= 2;
				body.push(cell.instrument);
			}
			if (cell.volume !== undefined) {
				mask |= 4;
				body.push(cell.volume);
			}
			if (cell.command !== undefined) {
				mask |= 8;
				body.push(cell.command, cell.param ?? 0);
			}
			pat.push((ch + 1) | 128, mask, ...body);
		}
		pat.push(0);
	}
	const out: number[] = [...ascii('IMPM', 4), ...ascii('test', 26), 0, 0];
	out.push(
		...u16(1),
		...u16(0),
		...u16(1),
		...u16(1),
		...u16(0x214),
		...u16(opts.cmwt ?? 0x214),
		...u16(0x0008 | 0x0001),
		...u16(0),
	);
	out.push(128, 48, opts.speed ?? 6, opts.tempo ?? 125, 128, 0, ...u16(0), ...u32(0), ...u32(0));
	out.push(...new Array(64).fill(32), ...new Array(64).fill(64));
	out.push(0, ...u32(sampleOffset), ...u32(patOffset));
	// sample header IMPS
	const smp = new Array<number>(0x50).fill(0);
	smp.splice(0, 4, ...ascii('IMPS', 4));
	smp[0x11] = 64; // global volume
	smp[0x12] = opts.sampleFlags ?? 1 | 16; // present + loop
	smp[0x13] = 64; // volume
	smp.splice(0x14, 26, ...ascii('smp', 26));
	smp[0x2e] = opts.cvt ?? 1; // signed
	smp.splice(0x30, 4, ...u32(sample.length));
	smp.splice(0x34, 4, ...u32(0));
	smp.splice(0x38, 4, ...u32(sample.length));
	smp.splice(0x3c, 4, ...u32(opts.c5speed ?? 8363));
	smp.splice(0x48, 4, ...u32(dataOffset));
	out.push(...smp, ...stored);
	out.push(...u16(pat.length), ...u16(rows), 0, 0, 0, 0, ...pat);
	return Uint8Array.from(out);
}

/** a minimal ScreamTracker 3 module: one channel, one 32 sample looped square, one pattern */
export function buildS3m(opts: {
	rows: { note?: number; instrument?: number; volume?: number; cmd?: number; info?: number }[];
	c2spd?: number;
	speed?: number;
}): Uint8Array {
	const sample = Array.from({ length: 32 }, (_, i) => (i < 16 ? 0xe0 : 0x20)); // unsigned 8 bit
	const header = new Uint8Array(0x60);
	header.set(ascii('test', 28), 0);
	header[0x1c] = 0x1a;
	header[0x1d] = 16;
	header.set(u16(1), 0x20);
	header.set(u16(1), 0x22);
	header.set(u16(1), 0x24);
	header.set(u16(0), 0x26);
	header.set(u16(0x1320), 0x28);
	header.set(u16(2), 0x2a);
	header.set(ascii('SCRM', 4), 0x2c);
	header[0x30] = 64;
	header[0x31] = opts.speed ?? 6;
	header[0x32] = 125;
	header[0x33] = 0;
	header.fill(255, 0x40, 0x60);
	header[0x40] = 0;
	const order = [0];
	const insParaOffset = 0x60 + order.length;
	const patParaOffset = insParaOffset + 2;
	const insPos = Math.ceil((patParaOffset + 2) / 16) * 16;
	const ins = new Uint8Array(0x50);
	ins[0] = 1;
	ins.set(ascii('smp', 12), 1);
	const samplePos = insPos + 0x50;
	ins[13] = 0;
	ins.set(u16(samplePos >> 4), 14);
	ins.set(u32(sample.length), 0x10);
	ins.set(u32(0), 0x14);
	ins.set(u32(sample.length), 0x18);
	ins[0x1c] = 64;
	ins[0x1f] = 1;
	ins.set(u32(opts.c2spd ?? 8363), 0x20);
	ins.set(ascii('SCRS', 4), 0x4c);
	const patPos = Math.ceil((samplePos + sample.length) / 16) * 16;
	const pat: number[] = [];
	for (let r = 0; r < 64; r++) {
		const c = opts.rows[r];
		if (c) {
			const flags =
				0 |
				(c.note !== undefined ? 32 : 0) |
				(c.volume !== undefined ? 64 : 0) |
				(c.cmd !== undefined ? 128 : 0);
			pat.push(
				flags,
				...(c.note !== undefined ? [c.note, c.instrument ?? 1] : []),
				...(c.volume !== undefined ? [c.volume] : []),
				...(c.cmd !== undefined ? [c.cmd, c.info ?? 0] : []),
			);
		}
		pat.push(0);
	}
	const total = patPos + 2 + pat.length;
	const out = new Uint8Array(total);
	out.set(header);
	out.set(order, 0x60);
	out.set(u16(insPos >> 4), insParaOffset);
	out.set(u16(patPos >> 4), patParaOffset);
	out.set(ins, insPos);
	out.set(sample, samplePos);
	out.set(u16(pat.length + 2), patPos);
	out.set(pat, patPos + 2);
	return out;
}

/** builds VGM files for tests */
export function buildVgm(opts: {
	commands: number[];
	sn?: number;
	ym2612?: number;
	ym2151?: number;
	ay?: number;
	opl2?: number;
	nes?: number;
	rate?: number;
	loopAt?: number; // offset in `commands` of the loop point
	totalSamples?: number;
	gd3?: { title: string; game: string; author: string };
}): Uint8Array {
	const header = new Uint8Array(0x100);
	const v = new DataView(header.buffer);
	header.set([0x56, 0x67, 0x6d, 0x20]);
	v.setUint32(0x08, 0x161, true);
	v.setUint32(0x0c, opts.sn ?? 0, true);
	v.setUint32(0x18, opts.totalSamples ?? 0, true);
	v.setUint32(0x24, opts.rate ?? 60, true);
	v.setUint16(0x28, 9, true);
	v.setUint32(0x2c, opts.ym2612 ?? 0, true);
	v.setUint32(0x30, opts.ym2151 ?? 0, true);
	v.setUint32(0x34, 0xcc, true); // data starts at 0x100
	v.setUint32(0x50, opts.opl2 ?? 0, true);
	v.setUint32(0x74, opts.ay ?? 0, true);
	v.setUint32(0x84, opts.nes ?? 0, true);
	const cmds = new Uint8Array([...opts.commands, 0x66]);
	let tail = new Uint8Array(0);
	if (opts.gd3) {
		const enc = (s: string): number[] => [...s].flatMap((c) => [c.charCodeAt(0), 0]).concat([0, 0]);
		const body = [
			...enc(opts.gd3.title),
			...enc(''),
			...enc(opts.gd3.game),
			...enc(''),
			...enc('Sega Mega Drive'),
			...enc(''),
			...enc(opts.gd3.author),
			...enc(''),
			...enc('2024'),
			...enc(''),
			...enc('notes'),
		];
		const hdr = [0x47, 0x64, 0x33, 0x20, 0, 1, 0, 0, body.length & 255, body.length >> 8, 0, 0];
		tail = new Uint8Array([...hdr, ...body]);
		v.setUint32(0x14, 0x100 + cmds.length - 0x14, true);
	}
	if (opts.loopAt !== undefined) v.setUint32(0x1c, 0x100 + opts.loopAt - 0x1c, true);
	const out = new Uint8Array(0x100 + cmds.length + tail.length);
	out.set(header);
	out.set(cmds, 0x100);
	out.set(tail, 0x100 + cmds.length);
	new DataView(out.buffer).setUint32(0x04, out.length - 4, true);
	return out;
}

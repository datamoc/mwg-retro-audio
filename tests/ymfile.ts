/** builds YM5! / YM6! files for tests */
export function buildYm(opts: {
	frames: number;
	regs: (frame: number) => number[]; // 16 values
	clock?: number;
	rate?: number;
	loop?: number;
	interleaved?: boolean;
	drums?: Uint8Array[];
	title?: string;
	version?: string;
}): Uint8Array {
	const out: number[] = [];
	const push32 = (v: number): void => void out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
	const push16 = (v: number): void => void out.push((v >> 8) & 255, v & 255);
	const str = (s: string): void => void out.push(...[...s].map((c) => c.charCodeAt(0)), 0);
	out.push(...[...(opts.version ?? 'YM6!')].map((c) => c.charCodeAt(0)));
	out.push(...[...'LeOnArD!'].map((c) => c.charCodeAt(0)));
	push32(opts.frames);
	push32(opts.interleaved === false ? 0 : 1);
	push16(opts.drums?.length ?? 0);
	push32(opts.clock ?? 2_000_000);
	push16(opts.rate ?? 50);
	push32(opts.loop ?? 0);
	push16(0);
	for (const d of opts.drums ?? []) {
		push32(d.length);
		out.push(...d);
	}
	str(opts.title ?? 'Test');
	str('Author');
	str('Comment');
	const frames = Array.from({ length: opts.frames }, (_, f) => opts.regs(f));
	if (opts.interleaved === false) for (const fr of frames) out.push(...fr);
	else for (let r = 0; r < 16; r++) for (const fr of frames) out.push(fr[r]);
	out.push(...[...'End!'].map((c) => c.charCodeAt(0)));
	return new Uint8Array(out);
}

/** builds a minimal ProTracker module for tests */
export interface ModNote {
	period?: number;
	sample?: number;
	effect?: number;
	param?: number;
}

export function buildMod(opts: {
	patterns: ModNote[][][]; // [pattern][row][channel]
	order?: number[];
	sample?: Int8Array;
	loop?: [number, number]; // in bytes
	volume?: number;
	finetune?: number;
	channels?: number;
}): Uint8Array {
	const channels = opts.channels ?? 4;
	const sample = opts.sample ?? Int8Array.from({ length: 64 }, (_, i) => (i < 32 ? 100 : -100));
	const out: number[] = new Array(20).fill(0);
	for (let s = 0; s < 31; s++) {
		const name = new Array(22).fill(0);
		const words = s === 0 ? sample.length >> 1 : 0;
		const loopStart = opts.loop ? opts.loop[0] >> 1 : 0;
		const loopLen = opts.loop ? (opts.loop[1] - opts.loop[0]) >> 1 : 1;
		out.push(
			...name,
			words >> 8,
			words & 255,
			(s === 0 ? (opts.finetune ?? 0) : 0) & 15,
			s === 0 ? (opts.volume ?? 64) : 0,
			loopStart >> 8,
			loopStart & 255,
			loopLen >> 8,
			loopLen & 255,
		);
	}
	const order = opts.order ?? opts.patterns.map((_, i) => i);
	out.push(order.length, 0, ...order, ...new Array(128 - order.length).fill(0));
	out.push(...[...(channels === 4 ? 'M.K.' : `${channels}CHN`)].map((c) => c.charCodeAt(0)));
	for (const pattern of opts.patterns) {
		for (let r = 0; r < 64; r++) {
			for (let c = 0; c < channels; c++) {
				const n = pattern[r]?.[c] ?? {};
				const period = n.period ?? 0;
				const smp = n.sample ?? 0;
				const eff = n.effect ?? 0;
				out.push((smp & 0xf0) | (period >> 8), period & 255, ((smp & 15) << 4) | eff, n.param ?? 0);
			}
		}
	}
	out.push(...Array.from(sample, (v) => v & 255));
	return Uint8Array.from(out);
}

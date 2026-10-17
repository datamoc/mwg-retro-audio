/**
 * Tables and helpers shared by the Yamaha FM chips (OPL2 / OPL3 / YM2612): the logarithmic sine and exponential
 * tables of the real chips and the envelope generator rate pattern.
 *
 * Levels are expressed in 1/256 octave (the unit of the chips' log-sine ROM); a level is turned back into a linear
 * amplitude (about +-4084 at level 0, as the 13 bit output of the chips) by `expLevel`.
 */

/** quarter-wave log sine ROM: `-log2(sin((i + 0.5) / 256 * pi / 2)) * 256` */
export const LOGSIN = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
	LOGSIN[i] = Math.round(-Math.log2(Math.sin(((i + 0.5) / 256) * (Math.PI / 2))) * 256);
}

const EXP = new Float32Array(256);
for (let i = 0; i < 256; i++) EXP[i] = 4084 * 2 ** (-i / 256);

/** amplitude of a level in 1/256 octave (>= 0): about 4084 * 2^(-level / 256) */
export function expLevel(level: number): number {
	if (level >= 256 * 13) return 0;
	return EXP[level & 255] / (1 << (level >> 8));
}

/** log level of the sine at a 10 bit phase, `[level, negative]` packed as level | (negative << 16) */
export function sineLevel(phase: number): number {
	const p = phase & 0x3ff;
	const q = p & 0x100 ? ~p & 0xff : p & 0xff;
	return LOGSIN[q] | (p & 0x200 ? 0x10000 : 0);
}

/**
 * Envelope increments per sample for the 15 patterns of the chips: rows 0-3 are rates with a low part of 0-3 for
 * the slow rates (increment 0 or 1), 4-7 / 8-11 are the fast rates and row 12 the fastest.
 */
const EG_INC = [
	0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
	1, 1, 1, 1, 2, 1, 1, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 2,
	2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 2, 4, 4, 4, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
];

/**
 * Envelope increment for an effective rate (0-63) at envelope counter `counter`.
 * `top` is the shift of rate 0 (12 for OPL, 11 for OPN): each +4 of rate halves the interval.
 */
export function egIncrement(rate: number, counter: number, top: number): number {
	if (rate <= 0) return 0;
	const rh = rate >> 2;
	const rl = rate & 3;
	let shift: number;
	let row: number;
	if (rh <= top) {
		shift = top - rh;
		row = rl;
	} else if (rh === top + 1) {
		shift = 0;
		row = 4 + rl;
	} else if (rh === top + 2) {
		shift = 0;
		row = 8 + rl;
	} else {
		shift = 0;
		row = 12;
	}
	if (counter & ((1 << shift) - 1)) return 0;
	return EG_INC[row * 8 + ((counter >> shift) & 7)];
}

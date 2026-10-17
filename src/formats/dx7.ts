/**
 * Yamaha DX7 voice banks: the SysEx "32 voices bulk dump" (`F0 43 0n 09 20 00`, 4096 bytes of packed voices,
 * checksum, `F7`) read into structured voices. This is the data side of specification section 8: the six operator
 * FM engine itself is documented there as outside the core and is not part of this package.
 */

export interface Dx7Operator {
	rates: [number, number, number, number];
	levels: [number, number, number, number];
	breakPoint: number;
	leftDepth: number;
	rightDepth: number;
	leftCurve: number;
	rightCurve: number;
	rateScale: number;
	detune: number;
	ampModSens: number;
	keyVelocitySens: number;
	outputLevel: number;
	/** 0 ratio, 1 fixed frequency */
	oscMode: number;
	freqCoarse: number;
	freqFine: number;
}

export interface Dx7Voice {
	name: string;
	/** operators 6 to 1, in the order the dump stores them */
	operators: Dx7Operator[];
	pitchEgRates: [number, number, number, number];
	pitchEgLevels: [number, number, number, number];
	/** algorithm 0-31 (1-32 on the panel) */
	algorithm: number;
	feedback: number;
	oscKeySync: boolean;
	lfo: {
		speed: number;
		delay: number;
		pitchModDepth: number;
		ampModDepth: number;
		sync: boolean;
		wave: number;
		pitchModSens: number;
	};
	transpose: number;
}

export function dx7Checksum(data: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < data.length; i++) sum += data[i] & 0x7f;
	return -sum & 0x7f;
}

export function isDx7Bank(b: Uint8Array): boolean {
	return (
		b.length >= 4104 &&
		b[0] === 0xf0 &&
		b[1] === 0x43 &&
		(b[2] & 0xf0) === 0 &&
		b[3] === 0x09 &&
		b[4] === 0x20 &&
		b[5] === 0x00
	);
}

/** Parse one 128 byte packed voice */
export function parseDx7Voice(v: ArrayLike<number>): Dx7Voice {
	const operators: Dx7Operator[] = [];
	for (let o = 0; o < 6; o++) {
		const p = o * 17;
		operators.push({
			rates: [v[p], v[p + 1], v[p + 2], v[p + 3]],
			levels: [v[p + 4], v[p + 5], v[p + 6], v[p + 7]],
			breakPoint: v[p + 8],
			leftDepth: v[p + 9],
			rightDepth: v[p + 10],
			leftCurve: v[p + 11] & 3,
			rightCurve: (v[p + 11] >> 2) & 3,
			rateScale: v[p + 12] & 7,
			detune: (v[p + 12] >> 3) & 15,
			ampModSens: v[p + 13] & 3,
			keyVelocitySens: (v[p + 13] >> 2) & 7,
			outputLevel: v[p + 14],
			oscMode: v[p + 15] & 1,
			freqCoarse: (v[p + 15] >> 1) & 31,
			freqFine: v[p + 16],
		});
	}
	return {
		name: String.fromCharCode(...Array.from({ length: 10 }, (_, i) => v[118 + i])).trimEnd(),
		operators,
		pitchEgRates: [v[102], v[103], v[104], v[105]],
		pitchEgLevels: [v[106], v[107], v[108], v[109]],
		algorithm: v[110] & 31,
		feedback: v[111] & 7,
		oscKeySync: (v[111] & 8) !== 0,
		lfo: {
			speed: v[112],
			delay: v[113],
			pitchModDepth: v[114],
			ampModDepth: v[115],
			sync: (v[116] & 1) !== 0,
			wave: (v[116] >> 1) & 7,
			pitchModSens: (v[116] >> 4) & 7,
		},
		transpose: v[117],
	};
}

/** Parse a 32 voice bulk dump; throws when the header is wrong or the checksum does not match */
export function parseDx7Bank(b: Uint8Array): Dx7Voice[] {
	if (!isDx7Bank(b)) throw new Error('not a DX7 32 voice bulk dump');
	const data = b.subarray(6, 6 + 4096);
	if (dx7Checksum(data) !== b[6 + 4096]) throw new Error('DX7 bank: bad checksum');
	return Array.from({ length: 32 }, (_, i) => parseDx7Voice(data.subarray(i * 128, i * 128 + 128)));
}

/** Build a bulk dump from 32 packed voices (testing and conversion) */
export function buildDx7Bank(packed: ArrayLike<ArrayLike<number>>, channel = 0): Uint8Array {
	const data = new Uint8Array(4096);
	for (let i = 0; i < 32; i++) for (let j = 0; j < 128; j++) data[i * 128 + j] = (packed[i]?.[j] ?? 0) & 0x7f;
	return Uint8Array.from([0xf0, 0x43, channel & 15, 0x09, 0x20, 0x00, ...data, dx7Checksum(data), 0xf7]);
}

/** `F0 43 0n 00 01 1B <155 bytes> checksum F7`: one voice in the unpacked layout of the edit buffer */
export function isDx7Single(b: Uint8Array): boolean {
	return (
		b.length >= 163 &&
		b[0] === 0xf0 &&
		b[1] === 0x43 &&
		(b[2] & 0xf0) === 0 &&
		b[3] === 0x00 &&
		b[4] === 0x01 &&
		b[5] === 0x1b
	);
}

/** Parse a single voice dump (unpacked, 155 bytes); throws on a bad header or checksum */
export function parseDx7Single(b: Uint8Array): Dx7Voice {
	if (!isDx7Single(b)) throw new Error('not a DX7 single voice dump');
	const d = b.subarray(6, 6 + 155);
	if (dx7Checksum(d) !== b[6 + 155]) throw new Error('DX7 voice: bad checksum');
	const packed = new Uint8Array(128);
	for (let o = 0; o < 6; o++) {
		const s = o * 21;
		const p = o * 17;
		for (let i = 0; i < 11; i++) packed[p + i] = d[s + i]; // rates, levels, break point, left depth, right depth
		packed[p + 11] = (d[s + 11] & 3) | ((d[s + 12] & 3) << 2);
		packed[p + 12] = (d[s + 13] & 7) | ((d[s + 20] & 15) << 3);
		packed[p + 13] = (d[s + 14] & 3) | ((d[s + 15] & 7) << 2);
		packed[p + 14] = d[s + 16];
		packed[p + 15] = (d[s + 17] & 1) | ((d[s + 18] & 31) << 1);
		packed[p + 16] = d[s + 19];
	}
	for (let i = 0; i < 4; i++) {
		packed[102 + i] = d[126 + i];
		packed[106 + i] = d[130 + i];
	}
	packed[110] = d[134];
	packed[111] = (d[135] & 7) | ((d[136] & 1) << 3);
	packed[112] = d[137];
	packed[113] = d[138];
	packed[114] = d[139];
	packed[115] = d[140];
	packed[116] = (d[141] & 1) | ((d[142] & 7) << 1) | ((d[143] & 7) << 4);
	packed[117] = d[144];
	for (let i = 0; i < 10; i++) packed[118 + i] = d[145 + i];
	return parseDx7Voice(packed);
}

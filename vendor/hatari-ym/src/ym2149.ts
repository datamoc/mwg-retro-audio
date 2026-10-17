/**
 * Bit-exact TypeScript port of the YM2149 / Atari ST sound chain of Hatari (src/sound.c, src/psg.c,
 * src/clocks_timings.c).  Hatari is Copyright (C) its authors and is distributed under the GNU GPL v2 or
 * later; this port is a derivative work and is distributed under the same licence.
 *
 * What is reproduced (Atari STF, 44.1 kHz default configuration of Hatari 2.5):
 *   1. YM2149 emulated cycle by cycle at 250 kHz (tone / noise / envelope counters, 17-bit noise LFSR)
 *   2. mixing of the 3 voices through the 16x16x16 table measured on a real ST (interpolated to 5 bits)
 *   3. the STF "C10" asymmetric low-pass filter, applied at 250 kHz
 *   4. resampling 250.663 kHz -> output rate by an exact weighted average ("weighted average N")
 *   5. the subsonic IIR high-pass filter
 * All arithmetic follows the C integer types (int32 / uint32 / int64 / int16) so the output samples are
 * identical to Hatari's.
 */
import { VOLUME_TABLE_ORIGINAL } from './volumeTable.ts';

export type LowPass = 'stf' | 'pwm' | 'none';
export type HighPass = 'iir' | 'none';
export type Resample = 'weighted-n' | 'weighted-2' | 'nearest';

export type Machine = 'stf-pal' | 'stf-ntsc';

/** Clock tree of the Atari STF as computed in Hatari's clocks_timings.c (integer divisions) */
export const MACHINE_CLOCKS: Record<Machine, { cpuFreq: number; ymFreq: number }> = {
	'stf-pal': { cpuFreq: 8021247, ymFreq: 2005311 },       // MCLK 32 084 988 Hz  -> CPU = MCLK/4, YM = CPU/4
	'stf-ntsc': { cpuFreq: 8010600, ymFreq: 2002650 },      // MCLK 32 042 400 Hz
};

export interface HatariYmOptions {
	/** preset for cpuFreq / ymFreq (default 'stf-pal', the machine of the reference recordings) */
	machine?: Machine;
	/** CPU frequency of the emulated machine, in Hz (STF PAL: 8 021 247) */
	cpuFreq?: number;
	/** YM2149 input clock, in Hz (STF PAL: 2 005 311 = CPU / 4) */
	ymFreq?: number;
	/** output sample rate (Hatari: 44 100) */
	sampleRate?: number;
	lowPass?: LowPass;
	highPass?: HighPass;
	resample?: Resample;
}

// 16 envelopes of 3 blocks: GODOWN=0, GOUP=1, DOWN=2, UP=3  (YmEnvDef in sound.c)
const ENV_GODOWN = 0, ENV_GOUP = 1, ENV_DOWN = 2, ENV_UP = 3;
const YM_ENV_DEF: number[][] = [
	[ENV_GODOWN, ENV_DOWN, ENV_DOWN], [ENV_GODOWN, ENV_DOWN, ENV_DOWN], [ENV_GODOWN, ENV_DOWN, ENV_DOWN], [ENV_GODOWN, ENV_DOWN, ENV_DOWN],
	[ENV_GOUP, ENV_DOWN, ENV_DOWN], [ENV_GOUP, ENV_DOWN, ENV_DOWN], [ENV_GOUP, ENV_DOWN, ENV_DOWN], [ENV_GOUP, ENV_DOWN, ENV_DOWN],
	[ENV_GODOWN, ENV_GODOWN, ENV_GODOWN], [ENV_GODOWN, ENV_DOWN, ENV_DOWN], [ENV_GODOWN, ENV_GOUP, ENV_GODOWN], [ENV_GODOWN, ENV_UP, ENV_UP],
	[ENV_GOUP, ENV_GOUP, ENV_GOUP], [ENV_GOUP, ENV_UP, ENV_UP], [ENV_GOUP, ENV_GODOWN, ENV_GOUP], [ENV_GOUP, ENV_DOWN, ENV_DOWN],
];

/** Convert a constant 4 bit volume to the internal 5 bit value (YmVolume4to5) */
const YM_VOLUME_4_TO_5 = [0, 1, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31];

const YM_SQUARE_UP = 0x1f;
const YM_MASK_1VOICE = 0x1f;
const YM_MASK_A = 0x1f, YM_MASK_B = 0x1f << 5, YM_MASK_C = 0x1f << 10;
const YM_OUTPUT_LEVEL = 0x7fff;                      // ST: amplitude of the final signal
const YM_BUFFER_250_SIZE = 32768;
const YM_BUFFER_250_SIZE_MASK = YM_BUFFER_250_SIZE - 1;

const toInt16 = (v: number): number => (v << 16) >> 16;

/** C integer division truncating toward zero */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** Build the 32x32x32 table (interpolate_volumetable) then normalise it (YM2149_Normalise_5bit_Table) */
function buildVolumeTable(): Int16Array {
	const o = VOLUME_TABLE_ORIGINAL;
	const t = new Uint16Array(32 * 32 * 32);
	const ix = (i: number, j: number, k: number): number => (i << 10) | (j << 5) | k;
	const interp = (a: number, b: number): number => Math.trunc(0.5 + Math.sqrt(a * b)) & 0xffff;

	for (let i = 1; i < 32; i += 2) {
		for (let j = 1; j < 32; j += 2) {
			for (let k = 1; k < 32; k += 2) t[ix(i, j, k)] = o[(((i - 1) / 2) << 8) | (((j - 1) / 2) << 4) | ((k - 1) / 2)];
			t[ix(i, j, 0)] = t[ix(i, j, 1)];
			t[ix(i, j, 1)] = t[ix(i, j, 3)];
			t[ix(i, j, 3)] = interp(t[ix(i, j, 1)], t[ix(i, j, 5)]);
			for (let k = 2; k < 32; k += 2) t[ix(i, j, k)] = interp(t[ix(i, j, k - 1)], t[ix(i, j, k + 1)]);
		}
		for (let k = 0; k < 32; k++) {
			t[ix(i, 0, k)] = t[ix(i, 1, k)];
			t[ix(i, 1, k)] = t[ix(i, 3, k)];
			t[ix(i, 3, k)] = interp(t[ix(i, 1, k)], t[ix(i, 5, k)]);
		}
		for (let j = 2; j < 32; j += 2)
			for (let k = 0; k < 32; k++) t[ix(i, j, k)] = interp(t[ix(i, j - 1, k)], t[ix(i, j + 1, k)]);
	}
	for (let j = 0; j < 32; j++)
		for (let k = 0; k < 32; k++) {
			t[ix(0, j, k)] = t[ix(1, j, k)];
			t[ix(1, j, k)] = t[ix(3, j, k)];
			t[ix(3, j, k)] = interp(t[ix(1, j, k)], t[ix(5, j, k)]);
		}
	for (let i = 2; i < 32; i += 2)
		for (let j = 0; j < 32; j++)
			for (let k = 0; k < 32; k++) t[ix(i, j, k)] = interp(t[ix(i - 1, j, k)], t[ix(i + 1, j, k)]);

	// YM2149_Normalise_5bit_Table: out = in * Level / Max  (C int arithmetic), not centered
	const max = t[0x7fff];
	const out = new Int16Array(32 * 32 * 32);
	for (let h = 0; h < 32 * 32 * 32; h++) out[h] = toInt16(idiv(t[h] * YM_OUTPUT_LEVEL, max));
	return out;
}

/** 16 envelope waveforms of 3 blocks x 32 volumes, each entry = (vol<<10)|(vol<<5)|vol (YM_MERGE_VOICE) */
function buildEnvelopes(): Uint16Array[] {
	const waves: Uint16Array[] = [];
	for (let env = 0; env < 16; env++) {
		const w = new Uint16Array(32 * 3);
		for (let block = 0; block < 3; block++) {
			let vol = 0, inc = 0;
			switch (YM_ENV_DEF[env][block]) {
				case ENV_GODOWN: vol = 31; inc = -1; break;
				case ENV_GOUP: vol = 0; inc = 1; break;
				case ENV_DOWN: vol = 0; inc = 0; break;
				case ENV_UP: vol = 31; inc = 0; break;
			}
			for (let i = 0; i < 32; i++) {
				w[block * 32 + i] = (vol << 10) | (vol << 5) | vol;
				vol += inc;
			}
		}
		waves.push(w);
	}
	return waves;
}

export class HatariYm {
	readonly cpuFreq: number;
	readonly ymFreq: number;
	readonly sampleRate: number;
	/** YM counters run at YM clock / 8 */
	readonly ymCounterFreq: number;
	private readonly lowPass: LowPass;
	private readonly highPass: HighPass;
	private readonly resampleMethod: Resample;

	private readonly ymout5: Int16Array;
	private readonly envWaves: Uint16Array[];

	// registers and internal state (names follow sound.c)
	readonly soundRegs = new Uint8Array(14);
	private toneAPer = 0; private toneACount = 0; private toneAVal = 0;
	private toneBPer = 0; private toneBCount = 0; private toneBVal = 0;
	private toneCPer = 0; private toneCCount = 0; private toneCVal = 0;
	private noisePer = 0; private noiseCount = 0; private noiseVal = 0;
	private envPer = 0; private envCount = 0; private envPos = 0; private envShape = 0;
	private mixerTA = 0; private mixerTB = 0; private mixerTC = 0;
	private mixerNA = 0; private mixerNB = 0; private mixerNC = 0;
	private rndRack = 1;
	private envMask3Voices = 0;
	private vol3Voices = 0;
	private freqDiv2 = 0;

	// 250 kHz ring buffer and clock conversion
	private readonly ymBuffer250 = new Int16Array(YM_BUFFER_250_SIZE);
	private bufWrite = 0;
	private bufRead = 0;
	private clock250 = 0;
	private clock250CpuClock = 0;
	private convertRemainder = 0;

	// resampler / filter state (C statics)
	private posFractNearest = 0;
	private posFractWeighted2 = 0;
	private posFractWeightedN = 0;       // uint32
	private lpfY0 = 0; private lpfX1 = 0;
	private hpfX1 = 0; private hpfY1 = 0; private hpfY0 = 0;

	// output
	private out: Int16Array = new Int16Array(1 << 16);
	private outLen = 0;
	/** total samples generated since reset */
	generated = 0;

	constructor(opts: HatariYmOptions = {}) {
		const m = MACHINE_CLOCKS[opts.machine ?? 'stf-pal'];
		this.cpuFreq = opts.cpuFreq ?? m.cpuFreq;
		this.ymFreq = opts.ymFreq ?? m.ymFreq;
		this.sampleRate = opts.sampleRate ?? 44100;
		this.ymCounterFreq = Math.trunc(this.ymFreq / 8);
		this.lowPass = opts.lowPass ?? 'stf';
		this.highPass = opts.highPass ?? 'iir';
		this.resampleMethod = opts.resample ?? 'weighted-n';
		this.ymout5 = buildVolumeTable();
		this.envWaves = buildEnvelopes();
		this.reset(0);
	}

	// ------------------------------------------------------------------------------------------------
	// Init / reset  (Sound_Init, Sound_Reset, Ym2149_Reset)
	// ------------------------------------------------------------------------------------------------

	/** Sound_Init + Sound_Reset at the given global CPU clock */
	reset(clock: number): void {
		this.ym2149Reset();
		this.clock250 = 0;
		this.clock250CpuClock = clock;
		this.convertRemainder = 0;
		this.ymBuffer250.fill(0);
		this.bufWrite = 0;
		this.bufRead = 0;
		this.outLen = 0;
		this.generated = 0;
		this.posFractNearest = 0; this.posFractWeighted2 = 0; this.posFractWeightedN = 0;
		this.lpfY0 = 0; this.lpfX1 = 0; this.hpfX1 = 0; this.hpfY1 = 0; this.hpfY0 = 0;
		this.ym2149Reset();                       // Sound_Reset() calls Ym2149_Reset() again
	}

	private ym2149Reset(): void {
		for (let i = 0; i < 14; i++) this.soundWriteReg(i, 0);
		this.soundWriteReg(7, 0xff);
		this.toneAPer = this.toneACount = 0;
		this.toneBPer = this.toneBCount = 0;
		this.toneCPer = this.toneCCount = 0;
		this.noisePer = this.noiseCount = 0;
		this.envPer = this.envCount = 0;
		this.envShape = this.envPos = 0;
		this.toneAVal = this.toneBVal = this.toneCVal = this.noiseVal = 0;
		this.rndRack = 1;
	}

	/** PSG_Reset: the PSG layer writes 0 to the 14 sound registers (without Sound_Update) */
	psgReset(): void {
		for (let i = 0; i < 14; i++) this.soundWriteReg(i, 0);
	}

	// ------------------------------------------------------------------------------------------------
	// Register access
	// ------------------------------------------------------------------------------------------------

	/**
	 * PSG_Set_DataRegister: create samples up to `clock`, mask the value, then Sound_WriteReg().
	 * `clock` is Cycles_GetClockCounterOnWriteAccess() in Hatari.
	 */
	writeData(clock: number, reg: number, value: number): void {
		if (reg >= 16) return;
		this.update(clock);
		let v = value & 0xff;
		if (reg === 1 || reg === 3 || reg === 5 || reg === 13) v &= 0x0f;
		else if (reg === 8 || reg === 9 || reg === 10 || reg === 6) v &= 0x1f;
		if (reg < 14) this.soundWriteReg(reg, v);
	}

	private tonePer(high: number, low: number): number { return ((high & 0x0f) << 8) + low; }

	/** Sound_WriteReg */
	soundWriteReg(reg: number, data: number): void {
		const r = this.soundRegs;
		switch (reg) {
			case 0: r[0] = data; this.toneAPer = this.tonePer(r[1], r[0]); break;
			case 1: r[1] = data & 0x0f; this.toneAPer = this.tonePer(r[1], r[0]); break;
			case 2: r[2] = data; this.toneBPer = this.tonePer(r[3], r[2]); break;
			case 3: r[3] = data & 0x0f; this.toneBPer = this.tonePer(r[3], r[2]); break;
			case 4: r[4] = data; this.toneCPer = this.tonePer(r[5], r[4]); break;
			case 5: r[5] = data & 0x0f; this.toneCPer = this.tonePer(r[5], r[4]); break;
			case 6: r[6] = data & 0x1f; this.noisePer = r[6] & 0x1f; break;
			case 7:
				r[7] = data & 0x3f;
				this.mixerTA = (data & (1 << 0)) ? 0xffff : 0;
				this.mixerTB = (data & (1 << 1)) ? 0xffff : 0;
				this.mixerTC = (data & (1 << 2)) ? 0xffff : 0;
				this.mixerNA = (data & (1 << 3)) ? 0xffff : 0;
				this.mixerNB = (data & (1 << 4)) ? 0xffff : 0;
				this.mixerNC = (data & (1 << 5)) ? 0xffff : 0;
				break;
			case 8: this.writeVolume(8, data, YM_MASK_A, 0); break;
			case 9: this.writeVolume(9, data, YM_MASK_B, 5); break;
			case 10: this.writeVolume(10, data, YM_MASK_C, 10); break;
			case 11: r[11] = data; this.envPer = (r[12] << 8) + r[11]; break;
			case 12: r[12] = data; this.envPer = (r[12] << 8) + r[11]; break;
			case 13:
				r[13] = data & 0xf;
				this.envPos = 0;
				this.envCount = 0;
				this.envShape = r[13];
				break;
		}
	}

	private writeVolume(reg: number, data: number, mask: number, shift: number): void {
		this.soundRegs[reg] = data & 0x1f;
		if (data & 0x10) {
			this.envMask3Voices |= mask;
			this.vol3Voices &= ~mask;
		} else {
			this.envMask3Voices &= ~mask;
			this.vol3Voices &= ~mask;
			this.vol3Voices |= YM_VOLUME_4_TO_5[this.soundRegs[reg]] << shift;
		}
		this.envMask3Voices &= 0xffff;
		this.vol3Voices &= 0xffff;
	}

	// ------------------------------------------------------------------------------------------------
	// Clock conversion and generation
	// ------------------------------------------------------------------------------------------------

	/** YM2149_UpdateClock_250_int_new + ClocksTimings_ConvertCycles: returns the number of 250 kHz ticks elapsed */
	private updateClock250(cpuClock: number): number {
		if (cpuClock <= this.clock250CpuClock) return 0;               // the global clock never goes backwards in Hatari
		const diff = cpuClock - this.clock250CpuClock;
		const total = diff * this.ymCounterFreq + this.convertRemainder;
		const cycles = Math.floor(total / this.cpuFreq);
		this.convertRemainder = total - cycles * this.cpuFreq;
		this.clock250 += cycles;
		this.clock250CpuClock = cpuClock;
		return cycles;
	}

	/** Sound_Update: build samples up until this CPU clock */
	update(cpuClock: number): number {
		const before = this.outLen;
		let nb = this.updateClock250(cpuClock);                   // YM2149_Run
		// Hatari calls Sound_Update at least once per VBL (< 5000 ticks), so its 250 kHz ring buffer is never
		// overrun.  A caller may skip over longer spans: process them in chunks and drain the output in between
		// (the output does not depend on how the work is split).
		while (nb > 0) {
			const chunk = Math.min(nb, 8192);
			this.doSamples250(chunk);
			this.generateOutput();
			nb -= chunk;
		}
		this.generateOutput();
		return this.outLen - before;
	}

	/** YM2149_DoSamples_250 */
	private doSamples250(n: number): void {
		const buf = this.ymBuffer250;
		const lut = this.ymout5;
		const lpf = this.lowPass;
		let pos = this.bufWrite;
		for (let c = 0; c < n; c++) {
			// noise counter runs at 125 kHz
			this.freqDiv2 ^= 1;
			if (this.freqDiv2 === 0) this.noiseCount = (this.noiseCount + 1) & 0xffff;
			if (this.noiseCount >= this.noisePer) {
				this.noiseCount = 0;
				if (this.rndRack & 1) { this.rndRack = ((this.rndRack >>> 1) ^ 0x12000) >>> 0; this.noiseVal = 0xffff; }
				else { this.rndRack >>>= 1; this.noiseVal = 0; }
			}

			this.toneACount = (this.toneACount + 1) & 0xffff;
			if (this.toneACount >= this.toneAPer) { this.toneACount = 0; this.toneAVal ^= YM_SQUARE_UP; }
			this.toneBCount = (this.toneBCount + 1) & 0xffff;
			if (this.toneBCount >= this.toneBPer) { this.toneBCount = 0; this.toneBVal ^= YM_SQUARE_UP; }
			this.toneCCount = (this.toneCCount + 1) & 0xffff;
			if (this.toneCCount >= this.toneCPer) { this.toneCCount = 0; this.toneCVal ^= YM_SQUARE_UP; }

			this.envCount = (this.envCount + 1) & 0xffff;
			if (this.envCount >= this.envPer) {
				this.envCount = 0;
				this.envPos += 1;
				if (this.envPos >= 3 * 32) this.envPos -= 2 * 32;
			}

			let env3 = this.envWaves[this.envShape][this.envPos];
			env3 &= this.envMask3Voices;

			let bt = (this.toneAVal | this.mixerTA) & (this.noiseVal | this.mixerNA);
			let tone3 = bt & YM_MASK_1VOICE;
			bt = (this.toneBVal | this.mixerTB) & (this.noiseVal | this.mixerNB);
			tone3 |= (bt & YM_MASK_1VOICE) << 5;
			bt = (this.toneCVal | this.mixerTC) & (this.noiseVal | this.mixerNC);
			tone3 |= (bt & YM_MASK_1VOICE) << 10;

			tone3 &= (env3 | this.vol3Voices);

			let sample = lut[tone3];
			if (lpf === 'stf') {
				// LowPassFilter(): asymmetric first order low-pass of the STF output stage
				const x0 = sample;
				let y0: number;
				if (x0 >= this.lpfY0) y0 = (3 * (x0 + this.lpfX1) + (this.lpfY0 << 1)) >> 3;
				else y0 = ((x0 + this.lpfX1) + 6 * this.lpfY0) >> 3;
				this.lpfY0 = y0;
				this.lpfX1 = x0;
				sample = toInt16(y0);
			} else if (lpf === 'pwm') {
				// PWMaliasFilter(): rising edges pass unchanged, falling edges are low-passed
				const x0 = sample;
				let y0: number;
				if (x0 >= this.lpfY0) y0 = x0;
				else y0 = (3 * (x0 + this.lpfX1) + (this.lpfY0 << 1)) >> 3;
				this.lpfY0 = y0;
				this.lpfX1 = x0;
				sample = toInt16(y0);
			}
			buf[pos] = sample;
			pos = (pos + 1) & YM_BUFFER_250_SIZE_MASK;
		}
		this.bufWrite = pos;
	}

	/** Sound_GenerateSamples (YM part): produce every output sample the 250 kHz buffer allows */
	private generateOutput(): void {
		const margin = Math.ceil(this.ymCounterFreq / this.sampleRate) + 2;
		while (((this.bufWrite - this.bufRead) & YM_BUFFER_250_SIZE_MASK) >= margin) {
			const s = this.hpf(this.nextSample250());
			this.push(s);
		}
	}

	private push(s: number): void {
		if (this.outLen >= this.out.length) {
			const bigger = new Int16Array(this.out.length * 2);
			bigger.set(this.out);
			this.out = bigger;
		}
		this.out[this.outLen++] = s;
		this.generated++;
	}

	/** Subsonic_IIR_HPF_Left (int32 arithmetic) */
	private hpf(x0: number): number {
		if (this.highPass === 'none') return x0;
		// Hatari 2.5.0: y1 += ((x0 - x1) << 15) - (y0 << 6);  y0 = y1 >> 15;   (arithmetic shift: rounds toward -infinity)
		this.hpfY1 = (this.hpfY1 + ((x0 - this.hpfX1) << 15) - (this.hpfY0 << 6)) | 0;
		this.hpfY0 = this.hpfY1 >> 15;
		this.hpfX1 = x0;
		return toInt16(this.hpfY0);
	}

	private nextSample250(): number {
		const buf = this.ymBuffer250;
		const stepD = this.ymCounterFreq / this.sampleRate;
		switch (this.resampleMethod) {
			case 'nearest': {
				let s: number;
				if (this.posFractNearest < 0.5) s = buf[this.bufRead];
				else s = buf[(this.bufRead + 1) & YM_BUFFER_250_SIZE_MASK];
				this.posFractNearest += stepD;
				this.bufRead = (this.bufRead + Math.trunc(this.posFractNearest)) & YM_BUFFER_250_SIZE_MASK;
				this.posFractNearest -= Math.trunc(this.posFractNearest);
				return s;
			}
			case 'weighted-2': {
				const before = buf[this.bufRead];
				const after = buf[(this.bufRead + 1) & YM_BUFFER_250_SIZE_MASK];
				const s = toInt16(Math.round((1.0 - this.posFractWeighted2) * before + this.posFractWeighted2 * after));
				this.posFractWeighted2 += stepD;
				this.bufRead = (this.bufRead + Math.trunc(this.posFractWeighted2)) & YM_BUFFER_250_SIZE_MASK;
				this.posFractWeighted2 -= Math.trunc(this.posFractWeighted2);
				return s;
			}
			default: {
				// YM2149_Next_Resample_Weighted_Average_N, fractions are 16.16 fixed point
				const interval = Math.floor((this.ymCounterFreq * 0x10000) / this.sampleRate);
				let total = 0;
				let pf = this.posFractWeightedN >>> 0;
				if (pf) {
					total += buf[this.bufRead] * (0x10000 - pf);
					this.bufRead = (this.bufRead + 1) & YM_BUFFER_250_SIZE_MASK;
					pf = (pf - 0x10000) >>> 0;                    // uint32 wrap
				}
				pf = (pf + interval) >>> 0;
				while (pf & 0xffff0000) {
					total += buf[this.bufRead] * 0x10000;
					this.bufRead = (this.bufRead + 1) & YM_BUFFER_250_SIZE_MASK;
					pf = (pf - 0x10000) >>> 0;
				}
				if (pf) total += buf[this.bufRead] * pf;
				this.posFractWeightedN = pf;
				return toInt16(idiv(total, interval));
			}
		}
	}

	/** Deep copy of the whole emulation state (used by search tools); the output buffer is not copied */
	clone(): HatariYm {
		const c = Object.create(HatariYm.prototype) as HatariYm;
		const src = this as unknown as Record<string, unknown>;
		const dst = c as unknown as Record<string, unknown>;
		for (const k of Object.keys(src)) {
			const v = src[k];
			if (k === 'out') dst[k] = new Int16Array(1 << 12);
			else dst[k] = v instanceof Int16Array || v instanceof Uint8Array ? v.slice() : v;
		}
		dst['outLen'] = 0;
		return c;
	}

	/** Remove and return the samples generated so far (mono: Hatari duplicates it to both channels) */
	takeSamples(): Int16Array {
		const r = this.out.slice(0, this.outLen);
		this.outLen = 0;
		return r;
	}

	/** All samples generated since the last takeSamples() */
	get pending(): number { return this.outLen; }
}

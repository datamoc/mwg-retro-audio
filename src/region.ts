/**
 * Video standard of the machine a piece of music was written for.
 *
 * The standard decides how fast the frame interrupt fires (the "tick" of a tracker or a register-dump player)
 * and, on most machines, the master clock of the sound chips, so it also moves the pitch of every note:
 * the player must follow the standard of the original file instead of assuming one, or the music runs fast or
 * slow and out of tune.
 */
export enum Region {
	/** 50 Hz: a frame lasts 20 ms */
	PAL = 50,
	/** 60 Hz: a frame lasts about 16.67 ms */
	NTSC = 60,
}

/** Nominal frame period in seconds for a region */
export function framePeriod(region: Region): number {
	return 1 / region;
}

/** The region whose nominal frame rate is the closest to `hz` (a 50.125 Hz C64 or a 59.94 Hz console both map correctly) */
export function regionFromFrameRate(hz: number): Region {
	return Math.abs(hz - Region.PAL) <= Math.abs(hz - Region.NTSC) ? Region.PAL : Region.NTSC;
}

/** Clock frequencies, in Hz, of the chips on the machines that used them, per video standard where it matters */
export const Clocks = {
	/** Yamaha YM2149 / General Instrument AY-3-8910 */
	ay: {
		/** Atari ST (STF): CPU clock / 4, exactly as Hatari derives it from the 32.084988 MHz PAL master clock */
		atariStPal: 2_005_311,
		/** Atari ST on the NTSC master clock (32.0424 MHz) */
		atariStNtsc: 2_002_650,
		/** nominal 2 MHz, used by most YM files */
		atariStNominal: 2_000_000,
		amstradCpc: 1_000_000,
		zxSpectrum128: 1_773_400,
		msx: 1_789_773,
	},
	/** Texas Instruments SN76489 */
	sn76489: { ntsc: 3_579_545, pal: 3_546_893 },
	/** Ricoh 2A03 / 2A07 (the CPU clock drives the APU) */
	nesApu: { ntsc: 1_789_773, pal: 1_662_607, dendy: 1_773_448 },
	/** MOS 6581 / 8580 (the PHI2 clock of the C64) */
	sid: { pal: 985_248, ntsc: 1_022_727 },
	/** Apple II: 14.31818 MHz / 14 with one long cycle in 65 (average); Europlus PAL 14.238 MHz / 14 */
	appleII: { ntsc: 1_020_484, pal: 1_015_657 },
	/** Yamaha YM2612 (master clock / 7, the chip divides by 6 internally) */
	ym2612: { ntsc: 7_670_454, pal: 7_600_489 },
	/** Yamaha YM3812 (OPL2) and YMF262 (OPL3) */
	opl: { opl2: 3_579_545, opl3: 14_318_180 },
} as const;

/** Precise frame rates of some machines, for the players that run a CPU routine once per frame */
export const FrameRates = {
	c64: { pal: 50.124542, ntsc: 59.826 },
	nes: { pal: 50.006978, ntsc: 60.098814 },
	megaDrive: { pal: 50.0, ntsc: 59.92 },
	atariSt: { pal: 50.0, ntsc: 60.0 },
} as const;

/**
 * Layer 2 - what every chip emulator offers to the players above it.
 *
 * A chip is driven exactly like the hardware: the player writes registers, in time order, and asks the chip for
 * the audio that follows. Register addresses and values keep the meaning they have on the real chip; each chip
 * documents how a multi-port chip (YM2612, OPL3) maps its ports onto `addr`.
 */
export interface Chip {
	/** short identifier: 'ym2149', 'sn76489', 'nes-apu', 'sid', 'ym2612', 'opl2', 'opl3' */
	readonly id: string;
	readonly name: string;
	/** number of sound channels the chip mixes, for UI and per-channel muting */
	readonly channels: number;
	/** master clock in Hz */
	readonly clock: number;
	/** output sample rate of this instance, in Hz */
	readonly sampleRate: number;

	/** power-on state */
	reset(): void;
	/** write a register (the address space is chip specific, see each chip) */
	write(addr: number, value: number): void;
	/** read a register or status port */
	read(addr: number): number;
	/**
	 * Optional: a write that happens `offset` output samples (fractional) after the last rendered sample. Chips whose
	 * sound depends on timing finer than a sample (the Apple II speaker toggles at cycle resolution) implement it, and
	 * the players use it when it exists.
	 */
	writeAt?(offset: number, addr: number, value: number): void;
	/**
	 * Generate `count` stereo frames and ADD them to `left` / `right` from index `start`, so several chips can share
	 * the same buffers. Mono chips write the same signal to both channels.
	 */
	render(left: Float32Array, right: Float32Array, start: number, count: number): void;
	/** silence a channel without disturbing the chip state (debugging, stems) */
	setMuted(channel: number, muted: boolean): void;
}

/** Options shared by every chip constructor */
export interface ChipOptions {
	/** output sample rate in Hz (default 44100) */
	sampleRate?: number;
	/** master clock in Hz (default: the nominal clock of the chip) */
	clock?: number;
}

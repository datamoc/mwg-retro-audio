/**
 * Roland MT-32 / CM-32L / LAPC-I and GS / Sound Canvas SysEx handling.
 *
 * The LA synthesis of the MT-32 family depends on proprietary ROMs that this engine does not ship: what is provided
 * is everything around them: exact SysEx parsing with the Roland checksum, the MT-32 memory map, the state a game
 * leaves in the unit (custom timbres, system area, LCD message) and the `LaRomProvider` socket where a synthesiser can
 * be plugged: `Mt32Synth` (ROM-free LA model, runs in a browser) or any other one the caller builds. Without one a
 * sequence is rendered through a General MIDI sound bank and reported as approximate (`Mt32Session.approximate`).
 */

export const ROLAND_ID = 0x41;
export const MODEL_MT32 = 0x16;
export const MODEL_GS = 0x42;

/** Roland checksum of address + data bytes: the value that makes their sum a multiple of 128 */
export function rolandChecksum(bytes: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < bytes.length; i++) sum += bytes[i];
	return (128 - (sum % 128)) % 128;
}

export interface RolandMessage {
	device: number;
	model: number;
	/** 0x12 = data set (DT1), 0x11 = data request (RQ1) */
	command: number;
	/** 24 bit address, 7 bits per byte as sent: 0x03 0x00 0x00 is 0x030000 */
	address: number;
	data: Uint8Array;
}

/** Parse a complete Roland SysEx (`F0 41 dev model cmd addr(3) data... checksum F7`); null when it is not one */
export function parseRolandSysEx(m: ArrayLike<number>): RolandMessage | null {
	const n = m.length;
	if (n < 10 || m[0] !== 0xf0 || m[1] !== ROLAND_ID || m[n - 1] !== 0xf7) return null;
	const addrData = Array.from({ length: n - 7 }, (_, i) => m[5 + i]); // address (3 bytes) + data, without the checksum
	if (rolandChecksum(addrData) !== m[n - 2]) return null;
	return {
		device: m[2],
		model: m[3],
		command: m[4],
		address: (m[5] << 16) | (m[6] << 8) | m[7],
		data: Uint8Array.from({ length: n - 10 }, (_, i) => m[8 + i]),
	};
}

/** Build a DT1 message with the correct checksum */
export function buildRolandDt1(model: number, device: number, address: number, data: ArrayLike<number>): Uint8Array {
	const addr = [(address >> 16) & 0x7f, (address >> 8) & 0x7f, address & 0x7f];
	const payload = [...addr, ...Array.from(data as ArrayLike<number>)];
	return Uint8Array.from([0xf0, ROLAND_ID, device, model, 0x12, ...payload, rolandChecksum(payload), 0xf7]);
}

/** Areas of the MT-32 memory map */
export const Mt32Memory = {
	patchTemporary: 0x030000,
	timbreTemporary: 0x040000,
	patchMemory: 0x050000,
	timbreMemory: 0x080000,
	system: 0x100000,
	display: 0x200000,
	reset: 0x7f0000,
} as const;

export type Mt32Area =
	'patchTemporary' | 'timbreTemporary' | 'patchMemory' | 'timbreMemory' | 'system' | 'display' | 'reset' | 'unknown';

export function mt32Area(address: number): Mt32Area {
	if (address >= Mt32Memory.reset) return 'reset';
	if (address >= Mt32Memory.display) return 'display';
	if (address >= Mt32Memory.system) return 'system';
	if (address >= Mt32Memory.timbreMemory) return 'timbreMemory';
	if (address >= Mt32Memory.patchMemory) return 'patchMemory';
	if (address >= Mt32Memory.timbreTemporary) return 'timbreTemporary';
	if (address >= Mt32Memory.patchTemporary) return 'patchTemporary';
	return 'unknown';
}

/** A synthesiser able to render LA synthesis, built by the caller from ROMs it is allowed to use */
export interface LaRomProvider {
	/** apply a SysEx, send MIDI bytes, then render stereo float audio */
	sysex(message: Uint8Array): void;
	midi(status: number, data1: number, data2: number): void;
	render(left: Float32Array, right: Float32Array, start: number, count: number): void;
}

/**
 * What a game has done to an MT-32: records every accepted SysEx so custom timbres and the system setup are kept
 * (and can be re-sent to a real unit or to a `LaRomProvider`), and the LCD text. Messages with a bad checksum are
 * refused and counted.
 */
export class Mt32Session {
	readonly sysex: Uint8Array[] = [];
	readonly memory = new Map<number, Uint8Array>();
	lcd = '';
	rejected = 0;
	resets = 0;
	/** true while no LA synthesiser is attached: the sound is a General MIDI approximation */
	approximate = true;
	private la: LaRomProvider | null = null;

	attach(provider: LaRomProvider): void {
		this.la = provider;
		this.approximate = false;
		for (const m of this.sysex) provider.sysex(m);
	}

	/** returns true when the message was a valid Roland message and was applied */
	receive(message: Uint8Array): boolean {
		const msg = parseRolandSysEx(message);
		if (!msg || msg.command !== 0x12) {
			if (message[1] === ROLAND_ID) this.rejected++;
			return false;
		}
		this.sysex.push(message.slice());
		this.la?.sysex(message);
		const area = mt32Area(msg.address);
		if (area === 'reset') {
			this.resets++;
			this.memory.clear();
			this.lcd = '';
		} else if (area === 'display') {
			this.lcd = String.fromCharCode(...msg.data)
				.replace(/[^\x20-\x7e]/g, ' ')
				.trimEnd();
		} else this.memory.set(msg.address, msg.data.slice());
		return true;
	}
}

/**
 * Approximation used when no LA synthesiser is attached: the program of an MT-32 patch (0-127) as a General MIDI
 * program. The MT-32 presets are laid out in the same sixteen families of eight as General MIDI (pianos, chromatic
 * percussion, organs, guitars, basses, strings, ensembles, brass, reeds, pipes, synth leads, pads, effects, ethnic,
 * percussive, sound effects), so the program number itself is the default; `overrides` replaces single entries for
 * the cases where a game's patch is known to sit elsewhere. Channel 1 of an MT-32 song is the rhythm channel and
 * maps to GM channel 10 (`mt32ChannelToGm`). The result is an approximation and `Mt32Session.approximate` stays true.
 */
export function mt32ToGm(program: number, overrides: Readonly<Record<number, number>> = {}): number {
	const p = program & 127;
	return overrides[p] ?? p;
}

/** MT-32 default part layout: part 1 (channel 2) .. part 8 (channel 9) melodic, channel 10 rhythm -> GM channel 10 (index 9) */
export function mt32ChannelToGm(channel: number): number {
	return channel & 15;
}

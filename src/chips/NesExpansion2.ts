import { BoxRenderer } from './BoxRenderer.ts';
import type { Chip, ChipOptions } from './Chip.ts';

/**
 * Namco 163 wavetable chip (Famicom cartridges): up to 8 channels playing 4 bit waveforms stored in a 128 byte
 * internal RAM that also holds the channel registers. Ports: address `$F800` (bit 7 = auto increment), data
 * `$4800`. Channel `n` registers sit at `0x78 - 8 * n .. 0x7F - 8 * n`: frequency (18 bit), phase (24 bit), wave
 * length (`256 - 4 * field`), wave address (in 4 bit samples) and volume; the high nibble of byte `0x7F` is the
 * number of active channels minus one. The channels are scanned one every 15 CPU cycles, so with `n` channels each
 * is updated every `15 * n` cycles and the pitch is `cpu * frequency / (15 * n * length * 2^16)`.
 */
export class Namco163 extends BoxRenderer implements Chip {
	readonly id = 'namco163';
	readonly name = 'Namco 163';
	readonly channels = 8;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly ram = new Uint8Array(128);
	private addr = 0;
	private autoInc = false;
	private slot = 0;
	private divider = 0;
	private readonly out = new Float64Array(8);
	private readonly muted = new Array<boolean>(8).fill(false);

	constructor(options: ChipOptions = {}) {
		const sampleRate = options.sampleRate ?? 44100;
		const clock = options.clock ?? 1_789_773;
		super(clock / sampleRate);
		this.clock = clock;
		this.sampleRate = sampleRate;
		this.reset();
	}

	reset(): void {
		this.ram.fill(0);
		this.addr = 0;
		this.autoInc = false;
		this.slot = 0;
		this.divider = 0;
		this.out.fill(0);
		this.resetBox();
	}

	write(addr: number, value: number): void {
		const v = value & 0xff;
		if ((addr & 0xf800) === 0xf800) {
			this.addr = v & 0x7f;
			this.autoInc = (v & 0x80) !== 0;
		} else if ((addr & 0xf800) === 0x4800) {
			this.ram[this.addr] = v;
			if (this.autoInc) this.addr = (this.addr + 1) & 0x7f;
		}
	}

	read(addr: number): number {
		if ((addr & 0xf800) !== 0x4800) return 0;
		const v = this.ram[this.addr];
		if (this.autoInc) this.addr = (this.addr + 1) & 0x7f;
		return v;
	}

	setMuted(channel: number, muted: boolean): void {
		if (channel >= 0 && channel < 8) this.muted[channel] = muted;
	}

	private sample(index: number): number {
		const b = this.ram[(index >> 1) & 0x7f];
		return index & 1 ? b >> 4 : b & 15;
	}

	protected step(): void {
		const n = ((this.ram[0x7f] >> 4) & 7) + 1;
		if (++this.divider >= 15) {
			this.divider = 0;
			// scan the active channels 8-n+1 .. 8 in turn (channel 8 is the last, at 0x78)
			const ch = 8 - n + this.slot;
			const o = 0x40 + ch * 8;
			const freq = this.ram[o] | (this.ram[o + 2] << 8) | ((this.ram[o + 4] & 3) << 16);
			let phase = this.ram[o + 1] | (this.ram[o + 3] << 8) | (this.ram[o + 5] << 16);
			const length = 256 - (this.ram[o + 4] & 0xfc);
			phase = (phase + freq) % (length << 16);
			this.ram[o + 1] = phase & 0xff;
			this.ram[o + 3] = (phase >> 8) & 0xff;
			this.ram[o + 5] = (phase >> 16) & 0xff;
			const vol = this.ram[o + 7] & 15;
			const s = this.sample(((phase >> 16) + this.ram[o + 6]) & 0xff);
			this.out[ch] = this.muted[ch] ? 0 : (s - 8) * vol;
			this.slot = (this.slot + 1) % n;
		}
		let sum = 0;
		for (let i = 8 - n; i < 8; i++) sum += this.out[i];
		// the chip multiplexes its channels on one output: the mix is the scan average
		this.curL = this.curR = sum / (n * 8 * 15) / 1.2;
	}
}

const FDS_MASTER = [30, 20, 15, 12];
const MOD_STEP = [0, 1, 2, 4, 0, -4, -2, -1];

/**
 * Famicom Disk System sound: one wavetable voice (64 samples of 6 bits, writable in RAM at `$4040-$407F` while
 * `$4089` bit 7 is set), a volume envelope, a frequency modulator driven by a 32 entry 3 bit table, and the master
 * volume. Registers `$4080-$408A` (`$4090` / `$4092` read the envelope gains). Pitch: `cpu * frequency / 2^22`.
 */
export class Fds extends BoxRenderer implements Chip {
	readonly id = 'fds';
	readonly name = 'Famicom Disk System audio';
	readonly channels = 1;
	readonly clock: number;
	readonly sampleRate: number;
	private readonly wave = new Uint8Array(64);
	private readonly modTable = new Uint8Array(64);
	private volGain = 0;
	private volSpeed = 0;
	private volMode = 0; // bit 7 disable, bit 6 increase
	private volTimer = 0;
	private modGain = 0;
	private modSpeed = 0;
	private modMode = 0;
	private modEnvTimer = 0;
	private freq = 0;
	private modFreq = 0;
	private modCounter = 0;
	private modPos = 0;
	private modPhase = 0;
	private phase = 0;
	private halt = true;
	private envDisable = false;
	private modDisable = true;
	private writeEnable = false;
	private master = 0;
	private envMaster = 0xe8;
	private muted = false;
	private level = 0;

	constructor(options: ChipOptions = {}) {
		const sampleRate = options.sampleRate ?? 44100;
		const clock = options.clock ?? 1_789_773;
		super(clock / sampleRate);
		this.clock = clock;
		this.sampleRate = sampleRate;
		this.reset();
	}

	reset(): void {
		this.wave.fill(0);
		this.modTable.fill(0);
		this.volGain = this.volSpeed = this.volMode = this.volTimer = 0;
		this.modGain = this.modSpeed = this.modMode = this.modEnvTimer = 0;
		this.freq = this.modFreq = this.modCounter = this.modPos = this.modPhase = this.phase = 0;
		this.halt = true;
		this.envDisable = false;
		this.modDisable = true;
		this.writeEnable = false;
		this.master = 0;
		this.envMaster = 0xe8;
		this.level = 0;
		this.resetBox();
	}

	setMuted(_channel: number, muted: boolean): void {
		this.muted = muted;
	}

	write(addr: number, value: number): void {
		const v = value & 0xff;
		if (addr >= 0x4040 && addr <= 0x407f) {
			if (this.writeEnable) this.wave[addr - 0x4040] = v & 63;
			return;
		}
		switch (addr) {
			case 0x4080:
				this.volMode = v & 0xc0;
				this.volSpeed = v & 63;
				if (v & 0x80) this.volGain = v & 63;
				this.volTimer = 0;
				break;
			case 0x4082:
				this.freq = (this.freq & 0xf00) | v;
				break;
			case 0x4083:
				this.freq = (this.freq & 0xff) | ((v & 15) << 8);
				this.halt = (v & 0x80) !== 0;
				this.envDisable = (v & 0x40) !== 0;
				if (this.halt) {
					this.phase = 0;
					this.modPhase = 0;
					this.modPos = 0;
				}
				if (this.envDisable) this.volTimer = this.modEnvTimer = 0;
				break;
			case 0x4084:
				this.modMode = v & 0xc0;
				this.modSpeed = v & 63;
				if (v & 0x80) this.modGain = v & 63;
				this.modEnvTimer = 0;
				break;
			case 0x4085:
				this.modCounter = ((v & 0x7f) << 25) >> 25;
				break;
			case 0x4086:
				this.modFreq = (this.modFreq & 0xf00) | v;
				break;
			case 0x4087:
				this.modFreq = (this.modFreq & 0xff) | ((v & 15) << 8);
				this.modDisable = (v & 0x80) !== 0;
				if (this.modDisable) this.modPhase = 0;
				break;
			case 0x4088:
				if (this.modDisable) {
					this.modTable[this.modPos & 63] = v & 7;
					this.modTable[(this.modPos + 1) & 63] = v & 7;
					this.modPos = (this.modPos + 2) & 63;
				}
				break;
			case 0x4089:
				this.master = v & 3;
				this.writeEnable = (v & 0x80) !== 0;
				break;
			case 0x408a:
				this.envMaster = v;
				break;
		}
	}

	read(addr: number): number {
		if (addr >= 0x4040 && addr <= 0x407f) return this.wave[addr - 0x4040];
		if (addr === 0x4090) return this.volGain & 63;
		if (addr === 0x4092) return this.modGain & 63;
		return 0;
	}

	/** the pitch modulation of the reference description of the modulator unit */
	private modulated(): number {
		let temp = this.modCounter * this.modGain;
		const remainder = temp & 15;
		temp >>= 4;
		if (remainder > 0 && !(temp & 0x80)) temp += this.modCounter < 0 ? -1 : 2;
		if (temp >= 192) temp -= 256;
		else if (temp < -64) temp += 256;
		temp *= this.freq;
		const r = temp & 63;
		temp >>= 6;
		if (r >= 32) temp++;
		return this.freq + temp;
	}

	protected step(): void {
		if (!this.halt && !this.envDisable) {
			const unit = 8 * (this.envMaster + 1);
			if (!(this.volMode & 0x80) && ++this.volTimer >= unit * (this.volSpeed + 1)) {
				this.volTimer = 0;
				if (this.volMode & 0x40) this.volGain = Math.min(32, this.volGain + 1);
				else this.volGain = Math.max(0, this.volGain - 1);
			}
			if (!(this.modMode & 0x80) && ++this.modEnvTimer >= unit * (this.modSpeed + 1)) {
				this.modEnvTimer = 0;
				if (this.modMode & 0x40) this.modGain = Math.min(32, this.modGain + 1);
				else this.modGain = Math.max(0, this.modGain - 1);
			}
		}
		if (!this.halt) {
			if (!this.modDisable && this.modFreq) {
				const before = this.modPhase;
				this.modPhase = (before + this.modFreq) % (1 << 22);
				// one step of the table every 2^16 of modulator phase (64 half steps of the 32 entry table)
				if (this.modPhase >> 16 !== before >> 16) {
					const entry = this.modTable[(this.modPhase >> 16) & 63];
					if (entry === 4) this.modCounter = 0;
					else this.modCounter = (((this.modCounter + MOD_STEP[entry]) << 25) >> 25) | 0;
				}
			}
			const f = this.modDisable ? this.freq : this.modulated();
			this.phase = (this.phase + Math.max(0, f)) % (64 << 16);
			if (!this.writeEnable) {
				const s = this.wave[this.phase >> 16];
				this.level = this.muted
					? 0
					: (s * Math.min(32, this.volGain) * FDS_MASTER[this.master]) / (63 * 32 * 30);
			}
		}
		this.curL = this.curR = this.level * 0.6;
	}
}

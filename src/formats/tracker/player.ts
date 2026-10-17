import type { Chip } from '../../chips/Chip.ts';
import { FramePlayer, type PlayerInfo } from '../../players/Player.ts';
import { Region } from '../../region.ts';
import type { LoadOptions } from '../mwa.ts';
import { ModuleMixer, type AmigaFilter, type Interpolation } from './mixer.ts';
import type { Cell, Envelope, Instrument, Sample, TrackerSong } from './types.ts';

export interface ModuleOptions extends LoadOptions {
	/** Amiga clock for period based songs: 'pal' (default) or 'ntsc' (the machine the file was written for) */
	standard?: 'pal' | 'ntsc';
	/** stereo separation 0 (mono) .. 1 (hard panned as on the Amiga); default 1 for MOD, 0.7 for the others */
	separation?: number;
	interpolation?: Interpolation;
	amigaFilter?: AmigaFilter;
	/** volume ramp in samples (default 64; 0 for Paula-exact clicks) */
	ramp?: number;
}

const PAULA_PAL = 7_093_789.2;
const PAULA_NTSC = 7_159_090.5;
/** the 32 entry quarter sine table of ProTracker */
const PT_SINE = [
	0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253, 255, 253, 250, 244, 235, 224, 212, 197,
	180, 161, 141, 120, 97, 74, 49, 24,
];

/** vibrato / tremolo waveform value (-255..255) at position `pos` (0..63): sine, ramp down, square, noise */
function waveValue(type: number, pos: number, noise: { state: number }): number {
	const p = pos & 63;
	switch (type & 3) {
		case 0:
			return p < 32 ? PT_SINE[p] : -PT_SINE[p - 32];
		case 1:
			return Math.round(255 - (p * 510) / 63);
		case 2:
			return p < 32 ? 255 : -255;
		default:
			noise.state = (noise.state * 1664525 + 1013904223) >>> 0; // deterministic: the same song always renders the same
			return (noise.state >>> 23) - 255;
	}
}

class Chan {
	sample: Sample | null = null;
	inst: Instrument | null = null;
	note = 0;
	period = 0;
	targetPeriod = 0;
	volume = 64;
	pan = 128;
	chanVol = 64;
	keyOn = false;
	fadeVol = 65536;
	volEnvTick = 0;
	panEnvTick = 0;
	active = false;
	voice = 0;
	// effect memory
	portaUp = 0;
	portaDown = 0;
	tonePorta = 0;
	vibSpeed = 0;
	vibDepth = 0;
	vibPos = 0;
	vibWave = 0;
	tremSpeed = 0;
	tremDepth = 0;
	tremPos = 0;
	tremWave = 0;
	volSlide = 0;
	panSlide = 0;
	offset = 0;
	retrigVol = 0;
	retrigRate = 0;
	globalSlide = 0;
	tremor = 0;
	loopRow = 0;
	loopCount = 0;
	// row state
	effect = 0;
	param = 0;
	volCol = 0;
	delayTick = -1;
	delayCell: Cell | null = null;
	cutTick = -1;
	arpOffset = 0;
	vibDelta = 0;
	tremDelta = 0;
	autoVibPos = 0;
	autoVibAge = 0;
	ghost = false;
}

/**
 * Plays a `TrackerSong` (MOD / XM / IT / S3M) tick by tick like the original players: the classic effect set of
 * ProTracker and FastTracker 2 (arpeggio, slides, tone portamento, vibrato, tremolo, volume and panning slides,
 * sample offset, jumps and pattern breaks, pattern loop and delay, retrigger, note cut and delay, fine slides,
 * global volume), the XM volume column, volume / panning envelopes with sustain and loop, fadeout, auto-vibrato
 * and the IT new note actions on background voices. Pitch follows the Amiga period tables or the linear frequency
 * table of the file. The tick rate follows the tempo (BPM * 2 / 5 Hz), so 125 BPM = the 50 Hz of a PAL Amiga.
 */
export class ModulePlayer extends FramePlayer {
	readonly info: PlayerInfo;
	readonly chips: Chip[];
	private readonly mixer: ModuleMixer;
	private readonly chans: Chan[];
	private ghosts: Chan[] = [];
	private readonly paula: number;
	private readonly loopSong: boolean;
	private readonly separation: number;
	private readonly noise = { state: 12345 };
	private speed: number;
	private tempo: number;
	private tick = 0;
	private row = 0;
	private order = 0;
	private nextOrder = -1;
	private nextRow = -1;
	private patternDelay = 0;
	private globalVol: number;
	private readonly visited = new Set<number>();
	private songEnded = false;
	private started = false;

	constructor(
		readonly song: TrackerSong,
		options: ModuleOptions = {},
	) {
		super(options.sampleRate ?? 44100);
		this.paula = options.standard === 'ntsc' ? PAULA_NTSC : PAULA_PAL;
		this.loopSong = options.loop ?? false;
		this.separation = options.separation ?? (song.format === 'mod' ? 1 : 0.7);
		this.speed = song.initialSpeed;
		this.tempo = song.initialTempo;
		this.globalVol = song.globalVolume;
		const ghostVoices = song.format === 'it' ? 32 : 0;
		this.mixer = new ModuleMixer({
			sampleRate: this.sampleRate,
			voices: song.channels + ghostVoices,
			interpolation: options.interpolation ?? 'linear',
			ramp: options.ramp,
			amigaFilter: options.amigaFilter,
		});
		this.chips = [this.mixer];
		this.chans = Array.from({ length: song.channels }, (_, i) => Object.assign(new Chan(), { voice: i }));
		this.info = {
			format: song.format,
			title: song.title || undefined,
			comment: song.comment,
			chips: ['tracker'],
			region: options.standard === 'ntsc' ? Region.NTSC : Region.PAL,
			frameRate: this.tempo * 0.4,
		};
	}

	protected currentFrameRate(): number {
		return Math.max(1, this.tempo * 0.4);
	}

	override get finished(): boolean {
		return this.songEnded && super.finished;
	}

	protected restart(): void {
		this.speed = this.song.initialSpeed;
		this.tempo = this.song.initialTempo;
		this.globalVol = this.song.globalVolume;
		this.tick = 0;
		this.row = 0;
		this.order = 0;
		this.nextOrder = this.nextRow = -1;
		this.patternDelay = 0;
		this.visited.clear();
		this.songEnded = false;
		this.started = false;
		this.noise.state = 12345;
		this.ghosts = [];
		this.chans.forEach((c, i) => {
			Object.assign(c, new Chan(), { voice: i });
			c.pan = this.song.defaultPan[i] ?? 128;
			c.chanVol = this.song.channelVolume[i] ?? 64;
		});
		this.mixer.reset();
	}

	// ------------------------------------------------------------------ pitch

	private periodFor(note: number, s: Sample): number {
		const n = note - 1 + s.relativeNote;
		if (this.song.linear) return 7680 - n * 64 - s.finetune / 2;
		return Math.round(6848 * 2 ** (-(n + s.finetune / 128) / 12));
	}

	private modPeriod(p: number, s: Sample): number {
		return p ? Math.round(p * 2 ** (-s.finetune / 96)) : 0;
	}

	private clampPeriod(p: number): number {
		if (this.song.linear) return Math.max(0, Math.min(15360, p));
		return this.song.format === 'mod' ? Math.max(113, Math.min(856, p)) : Math.max(1, Math.min(32767, p));
	}

	private autoVibratoDelta(c: Chan): number {
		const v = c.sample?.vibrato ?? c.inst?.vibrato;
		if (!v || !v.depth) return 0;
		const sweep = v.sweep ? Math.min(1, c.autoVibAge / v.sweep) : 1;
		const pos = c.autoVibPos & 255;
		const w =
			v.type === 0
				? Math.sin((pos / 256) * 2 * Math.PI)
				: v.type === 1
					? pos < 128
						? 1
						: -1
					: v.type === 2
						? 1 - pos / 128
						: pos / 128 - 1;
		return w * v.depth * sweep * (this.song.linear ? 1 : 2);
	}

	private frequency(c: Chan): number {
		const s = c.sample;
		if (!s || c.period <= 0) return 0;
		if (this.song.linear) {
			const ref = this.song.format === 'xm' ? 4608 : 3840;
			const p = c.period + c.vibDelta + this.autoVibratoDelta(c) - c.arpOffset * 64;
			return s.baseFreq * 2 ** ((ref - p) / 768);
		}
		const p = Math.max(1, c.period + c.vibDelta);
		return (this.paula / (2 * p)) * 2 ** (c.arpOffset / 12);
	}

	// ------------------------------------------------------------------ envelopes

	private envValue(env: Envelope | undefined, tick: number): number {
		if (!env || !env.enabled || env.points.length === 0) return -1;
		const pts = env.points;
		let i = 0;
		while (i + 1 < pts.length && pts[i + 1].tick <= tick) i++;
		if (i + 1 >= pts.length) return pts[i].value;
		const a = pts[i];
		const b = pts[i + 1];
		return b.tick === a.tick ? a.value : a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick);
	}

	private advanceEnv(env: Envelope | undefined, tick: number, keyOn: boolean): number {
		if (!env || !env.enabled || env.points.length === 0) return tick;
		const pts = env.points;
		const at = (i: number): number => pts[Math.min(Math.max(0, i), pts.length - 1)].tick;
		let t = tick + 1;
		if (env.sustain && keyOn && t > at(env.sustainEnd)) t = at(env.sustainStart);
		else if (env.loop && !(env.sustain && keyOn) && t > at(env.loopEnd)) t = at(env.loopStart);
		return Math.min(t, pts[pts.length - 1].tick);
	}

	// ------------------------------------------------------------------ rows

	private isMod(): boolean {
		return this.song.format === 'mod';
	}

	private startVoice(c: Chan, s: Sample, pos: number): void {
		const v = this.mixer.voices[c.voice];
		v.sample = s;
		v.pos = pos;
		v.dir = 1;
		v.active = true;
	}

	private sampleFor(c: Chan, note: number): Sample | undefined {
		const inst = c.inst;
		if (!inst) return undefined;
		if (this.isMod()) return inst.samples[0];
		const idx = inst.sampleMap
			? (inst.sampleMap[Math.max(0, Math.min(inst.sampleMap.length - 1, note - 1))] ?? 0)
			: 0;
		return inst.samples[idx] ?? inst.samples[0];
	}

	private applyCell(c: Chan, cell: Cell): void {
		const song = this.song;
		if (cell.instrument > 0) {
			const inst = song.instruments[cell.instrument - 1];
			if (inst) c.inst = inst;
		}
		const hasNote = this.isMod()
			? (cell.period ?? 0) > 0
			: cell.note >= 1 && cell.note <= (song.format === 'it' || song.format === 's3m' ? 120 : 96);
		const portaNote = cell.effect === 3 || cell.effect === 5 || (cell.volume & 0xf0) === 0xf0;
		if (song.format === 'xm' && cell.note === 97) {
			c.keyOn = false;
			return;
		}
		if (cell.note === 254) {
			c.active = false;
			this.mixer.voices[c.voice].active = false;
			return;
		}
		if (cell.note === 255) {
			c.keyOn = false;
			return;
		}
		const s = hasNote ? this.sampleFor(c, cell.note) : c.inst ? this.sampleFor(c, c.note || 49) : undefined;
		if (cell.instrument > 0 && s && c.inst) {
			// an instrument number reloads volume and panning, with or without a note
			c.volume = s.volume;
			if (s.pan >= 0) c.pan = s.pan;
			if (!hasNote && this.isMod() && c.sample) c.sample = s;
			c.fadeVol = 65536;
			c.volEnvTick = 0;
			c.panEnvTick = 0;
			c.keyOn = true;
		}
		if (!hasNote || !s) return;
		const period = this.isMod() ? this.modPeriod(cell.period ?? 0, s) : this.periodFor(cell.note, s);
		if (portaNote && c.sample) {
			c.targetPeriod = period;
			return;
		}
		if (song.format === 'it' && c.active && c.sample && (c.inst?.nna ?? 0) !== 0) this.makeGhost(c);
		c.sample = s;
		c.note = cell.note;
		c.period = c.targetPeriod = period;
		c.active = true;
		c.keyOn = true;
		if (cell.instrument === 0) {
			c.fadeVol = 65536;
			c.volEnvTick = 0;
			c.panEnvTick = 0;
		}
		c.autoVibPos = 0;
		c.autoVibAge = 0;
		if (!(c.vibWave & 4)) c.vibPos = 0;
		if (!(c.tremWave & 4)) c.tremPos = 0;
		c.vibDelta = 0;
		let pos = 0;
		if (cell.effect === 9) {
			if (cell.param) c.offset = cell.param;
			pos = c.offset * 256;
			if (pos >= s.data.length) pos = s.loopType ? s.loopStart : this.isMod() ? s.data.length : 0;
		}
		this.startVoice(c, s, pos);
	}

	private makeGhost(c: Chan): void {
		const nna = c.inst?.nna ?? 0;
		const ghost = Object.assign(new Chan(), c, { ghost: true });
		const used = new Set(this.ghosts.map((g) => g.voice));
		let vi = -1;
		for (let i = 0; i < 32; i++) if (!used.has(this.song.channels + i)) vi = this.song.channels + i;
		if (vi < 0) return;
		ghost.voice = vi;
		const src = this.mixer.voices[c.voice];
		const dst = this.mixer.voices[vi];
		Object.assign(dst, { ...src, muted: false });
		if (nna === 2 || nna === 3) ghost.keyOn = false;
		if (nna === 1) ghost.keyOn = true;
		this.ghosts.push(ghost);
	}

	private processRow(): void {
		const song = this.song;
		const pat = song.patterns[song.order[this.order]];
		const cells = pat?.cells[this.row] ?? [];
		for (let ch = 0; ch < song.channels; ch++) {
			const c = this.chans[ch];
			const cell = cells[ch] ?? { note: 0, instrument: 0, volume: 0, effect: 0, param: 0 };
			c.effect = cell.effect;
			c.param = cell.param;
			c.volCol = cell.volume;
			c.arpOffset = 0;
			c.delayTick = -1;
			c.cutTick = -1;
			if (cell.effect === 0xe && cell.param >> 4 === 0xd && (cell.param & 15) > 0) {
				c.delayTick = cell.param & 15;
				c.delayCell = cell;
			} else this.applyCell(c, cell);
			this.rowEffect(c, cell);
		}
	}

	private rowEffect(c: Chan, cell: Cell): void {
		const p = cell.param;
		const x = p >> 4;
		const y = p & 15;
		const vc = cell.volume;
		const hi = vc & 0xf0;
		if (vc >= 0x10 && vc <= 0x50) c.volume = vc - 0x10;
		else if (hi === 0x80) c.volume = Math.max(0, c.volume - (vc & 15));
		else if (hi === 0x90) c.volume = Math.min(64, c.volume + (vc & 15));
		else if (hi === 0xa0) {
			if (vc & 15) c.vibSpeed = vc & 15;
		} else if (hi === 0xb0) {
			if (vc & 15) c.vibDepth = vc & 15;
		} else if (hi === 0xc0) c.pan = (vc & 15) * 17;
		else if (hi === 0xf0 && vc & 15) c.tonePorta = (vc & 15) * 16;
		switch (cell.effect) {
			case 0x1:
				if (p) c.portaUp = p;
				break;
			case 0x2:
				if (p) c.portaDown = p;
				break;
			case 0x3:
				if (p) c.tonePorta = p;
				break;
			case 0x4:
				if (x) c.vibSpeed = x;
				if (y) c.vibDepth = y;
				break;
			case 0x5:
			case 0x6:
			case 0xa:
				if (p) c.volSlide = p;
				break;
			case 0x7:
				if (x) c.tremSpeed = x;
				if (y) c.tremDepth = y;
				break;
			case 0x8:
				c.pan = p;
				break;
			case 0xb:
				this.nextOrder = p;
				this.nextRow = 0;
				break;
			case 0xc:
				c.volume = Math.min(64, p);
				break;
			case 0xd:
				if (this.nextOrder < 0) this.nextOrder = this.order + 1;
				this.nextRow = p;
				break;
			case 0xe:
				this.extended(c, x, y);
				break;
			case 0xf:
				if (p === 0) break;
				if (p < 32) this.speed = p;
				else this.tempo = p;
				break;
			case 0x10:
				this.globalVol = Math.min(64, p);
				break;
			case 0x11:
				if (p) c.globalSlide = p;
				break;
			case 0x14:
				c.keyOn = false;
				break;
			case 0x30:
				c.chanVol = Math.min(64, p);
				break;
			case 0x19:
				if (p) c.panSlide = p;
				break;
			case 0x1b:
				if (x) c.retrigVol = x;
				if (y) c.retrigRate = y;
				break;
			case 0x1d:
				if (p) c.tremor = p;
				break;
			case 0x21:
				if (x === 1) c.period = this.clampPeriod(c.period - y);
				else if (x === 2) c.period = this.clampPeriod(c.period + y);
				break;
		}
	}

	private extended(c: Chan, sub: number, y: number): void {
		const linear = this.song.linear;
		switch (sub) {
			case 0x0:
				this.mixer.led = y === 0;
				break;
			case 0x1:
				c.period = this.clampPeriod(c.period - (linear ? y * 4 : y));
				break;
			case 0x2:
				c.period = this.clampPeriod(c.period + (linear ? y * 4 : y));
				break;
			case 0x4:
				c.vibWave = y;
				break;
			case 0x5:
				if (c.sample) c.sample = { ...c.sample, finetune: this.isMod() ? (y < 8 ? y : y - 16) : (y - 8) * 16 };
				break;
			case 0x6:
				if (y === 0) c.loopRow = this.row;
				else if (c.loopCount === 0) {
					c.loopCount = y;
					this.nextRow = c.loopRow;
					this.nextOrder = this.order;
				} else if (--c.loopCount > 0) {
					this.nextRow = c.loopRow;
					this.nextOrder = this.order;
				}
				break;
			case 0x7:
				c.tremWave = y;
				break;
			case 0x8:
				c.pan = y * 17;
				break;
			case 0x9:
				c.retrigRate = y;
				c.retrigVol = 0;
				break;
			case 0xa:
				c.volume = Math.min(64, c.volume + y);
				break;
			case 0xb:
				c.volume = Math.max(0, c.volume - y);
				break;
			case 0xc:
				c.cutTick = y;
				if (y === 0) c.volume = 0;
				break;
			case 0xe:
				this.patternDelay = y;
				break;
		}
	}

	// ------------------------------------------------------------------ per tick effects

	private tickEffects(c: Chan): void {
		const t = this.tick;
		const p = c.param;
		const x = p >> 4;
		const y = p & 15;
		const unit = this.song.linear ? 4 : 1;
		if (c.delayTick >= 0 && t === c.delayTick && c.delayCell) {
			this.applyCell(c, c.delayCell);
			c.delayTick = -1;
		}
		if (c.cutTick >= 0 && t === c.cutTick) c.volume = 0;
		// volume column slides
		const hi = c.volCol & 0xf0;
		if (hi === 0x60) c.volume = Math.max(0, c.volume - (c.volCol & 15));
		else if (hi === 0x70) c.volume = Math.min(64, c.volume + (c.volCol & 15));
		else if (hi === 0xb0) this.vibrato(c);
		else if (hi === 0xd0) c.pan = Math.max(0, c.pan - (c.volCol & 15));
		else if (hi === 0xe0) c.pan = Math.min(255, c.pan + (c.volCol & 15));
		else if (hi === 0xf0) this.slideToTarget(c);
		switch (c.effect) {
			case 0x0:
				if (p) c.arpOffset = [0, x, y][t % 3];
				break;
			case 0x1:
				c.period = this.clampPeriod(c.period - c.portaUp * unit);
				break;
			case 0x2:
				c.period = this.clampPeriod(c.period + c.portaDown * unit);
				break;
			case 0x3:
				this.slideToTarget(c);
				break;
			case 0x4:
				this.vibrato(c);
				break;
			case 0x5:
				this.slideToTarget(c);
				this.slideVolume(c);
				break;
			case 0x6:
				this.vibrato(c);
				this.slideVolume(c);
				break;
			case 0x7:
				c.tremDelta = (waveValue(c.tremWave, c.tremPos, this.noise) * c.tremDepth) >> 6;
				c.tremPos += c.tremSpeed;
				break;
			case 0xa:
				this.slideVolume(c);
				break;
			case 0x11:
				if (c.globalSlide >> 4) this.globalVol = Math.min(64, this.globalVol + (c.globalSlide >> 4));
				else this.globalVol = Math.max(0, this.globalVol - (c.globalSlide & 15));
				break;
			case 0x19:
				if (c.panSlide >> 4) c.pan = Math.min(255, c.pan + (c.panSlide >> 4));
				else c.pan = Math.max(0, c.pan - (c.panSlide & 15));
				break;
			case 0x1b:
				if (c.retrigRate > 0 && t % c.retrigRate === 0) this.retrigger(c);
				break;
			case 0x1d:
				c.tremDelta = t % (x + y + 2) < x + 1 ? 0 : -64;
				break;
			case 0xe:
				if (x === 0x9 && y > 0 && t % y === 0) this.retrigger(c);
				break;
		}
	}

	private retrigger(c: Chan): void {
		if (c.sample) this.startVoice(c, c.sample, 0);
		const x = c.retrigVol;
		const delta = [0, -1, -2, -4, -8, -16, 0, 0, 0, 1, 2, 4, 8, 16, 0, 0][x];
		if (x === 6) c.volume = Math.floor((c.volume * 2) / 3);
		else if (x === 7) c.volume = c.volume >> 1;
		else if (x === 14) c.volume = Math.min(64, Math.floor((c.volume * 3) / 2));
		else if (x === 15) c.volume = Math.min(64, c.volume * 2);
		else c.volume = Math.max(0, Math.min(64, c.volume + delta));
	}

	private slideVolume(c: Chan): void {
		const x = c.volSlide >> 4;
		const y = c.volSlide & 15;
		if (x) c.volume = Math.min(64, c.volume + x);
		else if (y) c.volume = Math.max(0, c.volume - y);
	}

	private slideToTarget(c: Chan): void {
		if (!c.targetPeriod || c.period === c.targetPeriod) return;
		const step = c.tonePorta * (this.song.linear ? 4 : 1);
		c.period =
			c.period > c.targetPeriod
				? Math.max(c.targetPeriod, c.period - step)
				: Math.min(c.targetPeriod, c.period + step);
	}

	private vibrato(c: Chan): void {
		const w = waveValue(c.vibWave, c.vibPos, this.noise);
		// ProTracker: (sine * depth) >> 7 in period units; the linear tables have 4 times finer steps
		c.vibDelta = this.song.linear ? (w * c.vibDepth) >> 5 : (w * c.vibDepth) >> 7;
		c.vibPos += c.vibSpeed;
	}

	// ------------------------------------------------------------------ mixer update

	private updateVoice(c: Chan): void {
		const v = this.mixer.voices[c.voice];
		const s = c.sample;
		if (!s || !c.active) {
			v.active = false;
			v.volL = v.volR = 0;
			return;
		}
		const song = this.song;
		let vol = Math.max(0, Math.min(64, c.volume + c.tremDelta)) / 64;
		let pan = c.pan / 255;
		if (c.inst && !this.isMod()) {
			const ve = this.envValue(c.inst.volEnv, c.volEnvTick);
			if (ve >= 0) vol *= Math.min(64, ve) / 64;
			const pe = this.envValue(c.inst.panEnv, c.panEnvTick);
			if (pe >= 0) pan += ((pe - 32) / 32) * (0.5 - Math.abs(pan - 0.5));
			if (!c.keyOn) c.fadeVol = Math.max(0, c.fadeVol - c.inst.fadeout * 2);
			vol *= c.fadeVol / 65536;
			c.volEnvTick = this.advanceEnv(c.inst.volEnv, c.volEnvTick, c.keyOn);
			c.panEnvTick = this.advanceEnv(c.inst.panEnv, c.panEnvTick, c.keyOn);
			c.autoVibPos += c.sample?.vibrato?.rate ?? c.inst.vibrato?.rate ?? 0;
			c.autoVibAge++;
			// a released note with no volume envelope and no fadeout is silent (XM); IT ghosts end when faded out
			if (!c.keyOn && !c.inst.volEnv?.enabled && c.inst.fadeout === 0 && song.format === 'xm') vol = 0;
			if (!c.keyOn && c.fadeVol === 0) c.active = false;
		}
		vol *= (this.globalVol / 64) * (c.chanVol / 64);
		pan = 0.5 + (Math.max(0, Math.min(1, pan)) - 0.5) * this.separation;
		const gain = 1 / Math.sqrt(Math.max(4, song.channels)); // keeps many channel songs below clipping
		v.volL = vol * Math.min(1, 2 * (1 - pan)) * gain * 2;
		v.volR = vol * Math.min(1, 2 * pan) * gain * 2;
		const f = this.frequency(c);
		v.step = f / this.sampleRate;
		v.sample = s;
		if (f <= 0) v.active = false;
	}

	protected beginFrame(): boolean {
		const song = this.song;
		if (this.songEnded) return false;
		if (!this.started) {
			this.started = true;
			this.chans.forEach((c, i) => {
				c.pan = song.defaultPan[i] ?? 128;
				c.chanVol = song.channelVolume[i] ?? 64;
			});
		}
		if (this.tick === 0) {
			const key = this.order * 4096 + this.row;
			if (this.patternDelay === 0 && !this.loopSong && this.visited.has(key)) {
				this.songEnded = true;
				return false;
			}
			if (this.patternDelay === 0) this.visited.add(key);
			this.processRow();
		} else for (const c of this.chans) this.tickEffects(c);
		for (const c of this.chans) {
			this.updateVoice(c);
			if (c.effect !== 7 && c.effect !== 0x1d) c.tremDelta = 0;
			if (c.effect !== 4 && c.effect !== 6 && (c.volCol & 0xf0) !== 0xb0) c.vibDelta = 0;
		}
		for (const g of this.ghosts) this.updateVoice(g);
		this.ghosts = this.ghosts.filter((g) => g.active);
		this.advance();
		return true;
	}

	private advance(): void {
		const song = this.song;
		if (++this.tick < this.speed * (this.patternDelay + 1)) return;
		this.tick = 0;
		this.patternDelay = 0;
		for (const c of this.chans) c.delayCell = null;
		let order = this.order;
		let row = this.row + 1;
		if (this.nextOrder >= 0) {
			order = this.nextOrder;
			row = this.nextRow >= 0 ? this.nextRow : 0;
		} else if (this.nextRow >= 0) row = this.nextRow;
		this.nextOrder = this.nextRow = -1;
		const pat = song.patterns[song.order[order]];
		if (pat && row >= pat.rows) {
			order++;
			row = 0;
		}
		if (order >= song.order.length) {
			if (this.loopSong) {
				order = Math.min(song.restartPosition, song.order.length - 1);
				this.visited.clear();
			} else {
				this.songEnded = true;
				return;
			}
		}
		this.order = order;
		this.row = row;
	}
}

import type { Chip, ChipOptions } from '../chips/Chip.ts';
import { createChip } from '../chips/index.ts';
import { Region } from '../region.ts';
import { AyDriver, driverFor, type ChipDriver, type VoiceValues } from './drivers.ts';
import type { SfxBank, SfxChip, SfxCurve, SfxDefinition, SfxVoiceProgram } from './types.ts';

/** digitised sound as levels 0..1 (4 bit values are 0..15, signed 8 bit data is offset, unsigned used as is) */
function normalisePcm(s: NonNullable<SfxVoiceProgram['sample']>): Float32Array {
	const out = new Float32Array(s.data.length);
	for (let i = 0; i < out.length; i++) {
		const v = s.data[i];
		out[i] = s.bits === 4 ? (v & 15) / 15 : s.data instanceof Int8Array ? (v + 128) / 255 : v / 255;
	}
	return out;
}

/** value of a curve at `tick`; `undefined` when the curve has no values */
export function evalCurve(c: SfxCurve | undefined, tick: number): number | undefined {
	if (!c) return undefined;
	if (c.values && c.values.length) {
		const v = c.values;
		if (tick < v.length) return v[tick];
		if (c.loopStart === undefined) return v[v.length - 1];
		const start = Math.min(c.loopStart, v.length - 1);
		const len = v.length - start;
		const t = tick - v.length;
		if (!c.pingPong) return v[start + (t % len)];
		const span = Math.max(1, len - 1);
		const k = t % (2 * span);
		return v[v.length - 1 - (k <= span ? k : 2 * span - k)];
	}
	if (c.start !== undefined) {
		const raw = c.start + (c.step ?? 0) * tick;
		return Math.max(c.min ?? -Infinity, Math.min(c.max ?? Infinity, raw));
	}
	return undefined;
}

/** true when a curve has produced its last distinct value by `tick` (tables not looping, ramps at their bound) */
function curveDone(c: SfxCurve | undefined, tick: number): boolean {
	if (!c) return true;
	if (c.values) return c.loopStart === undefined && tick >= c.values.length - 1;
	if (c.ticks !== undefined) return tick >= c.ticks;
	if (c.step === undefined || c.step === 0) return true;
	const v = evalCurve(c, tick)!;
	return c.step > 0 ? c.max !== undefined && v >= c.max : c.min !== undefined && v <= c.min;
}

const REGISTRY_ID: Record<SfxChip, string> = {
	ym2149: 'ym2149',
	ay8910: 'ay8910',
	sn76489: 'sn76489',
	nes: 'nes-apu',
	sid: 'sid',
	opl2: 'opl2',
	opl3: 'opl3',
	ym2612: 'ym2612',
	'pc-speaker': 'pc-speaker',
	saa1099: 'saa1099',
};

/** chip id reported by an emulator -> the SfxChip family of the definitions */
function familyOf(chip: Chip): SfxChip {
	switch (chip.id) {
		case 'nes-apu':
			return 'nes';
		case 'ym2149':
			return 'ym2149';
		default:
			return chip.id as SfxChip;
	}
}

function sameFamily(def: SfxChip, chip: SfxChip): boolean {
	if (def === chip) return true;
	return (def === 'ay8910' && chip === 'ym2149') || (def === 'ym2149' && chip === 'ay8910');
}

/**
 * A chip as seen by the music player when sound effects are active: writes pass through a driver that can lend
 * channels to effects, and rendering is cut at effect ticks so that effect register writes land on the exact sample.
 */
export class SfxGuard implements Chip {
	readonly id: string;
	readonly name: string;
	readonly channels: number;
	readonly clock: number;
	readonly sampleRate: number;
	/** frames rendered so far: the position the engine ticks are synchronised on */
	pos = 0;
	nextTick = 0;
	private pcm: { owner: number; channel: number; data: Float32Array; step: number; at: number }[] = [];

	constructor(
		readonly inner: Chip,
		readonly driver: ChipDriver | null,
		private readonly engine: SfxEngine,
	) {
		this.id = inner.id;
		this.name = inner.name;
		this.channels = inner.channels;
		this.clock = inner.clock;
		this.sampleRate = inner.sampleRate;
	}

	reset(): void {
		this.pos = 0;
		this.nextTick = 0;
		this.driver?.reset();
		this.inner.reset();
	}
	write(addr: number, value: number): void {
		if (this.driver) this.driver.music(addr, value);
		else this.inner.write(addr, value);
	}
	read(addr: number): number {
		return this.inner.read(addr);
	}
	setMuted(channel: number, muted: boolean): void {
		this.inner.setMuted(channel, muted);
	}
	/** start a digitised sound on a claimed channel: one volume register write per sample, at the sample's rate */
	startPcm(owner: number, channel: number, data: Float32Array, rate: number): void {
		this.pcm.push({ owner, channel, data, step: rate / this.sampleRate, at: 0 });
	}

	stopPcm(owner: number): void {
		this.pcm = this.pcm.filter((p) => p.owner !== owner);
	}

	hasPcm(owner: number): boolean {
		return this.pcm.some((p) => p.owner === owner);
	}

	private stepPcm(): void {
		for (const p of this.pcm) {
			const i = Math.floor(p.at);
			if (i >= p.data.length) continue;
			this.driver?.pcm(p.channel, p.data[i]);
			p.at += p.step;
		}
		this.pcm = this.pcm.filter((p) => p.at < p.data.length);
	}

	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		let done = 0;
		const period = this.sampleRate / this.engine.tickRate;
		while (done < count) {
			const boundary = Math.ceil(this.nextTick * period);
			if (this.pos >= boundary) {
				this.engine.runTick(this.nextTick);
				this.nextTick++;
				continue;
			}
			// a digitised sound writes its register at the sample rate: render sample by sample while one plays
			const n = this.pcm.length ? 1 : Math.min(count - done, boundary - this.pos);
			if (this.pcm.length) this.stepPcm();
			this.inner.render(left, right, start + done, n);
			this.pos += n;
			done += n;
		}
	}
}

interface Claim {
	guard: SfxGuard;
	channel: number;
	program: SfxVoiceProgram;
	/** dedicated chip mode: an own chip instance rendered next to the music */
	dedicated?: Chip;
}

interface Instance {
	id: number;
	def: SfxDefinition;
	priority: number;
	tick: number;
	acc: number;
	claims: Claim[];
	volume: number;
	pitchOffset: number;
	ended: boolean;
}

export interface SfxEngineOptions {
	/** original standard: sets the tick rate (50 / 60 Hz) */
	region?: Region;
	/** explicit tick rate in Hz (overrides the region) */
	tickRate?: number;
	/** maximum simultaneous effects (default 8) */
	maxVoices?: number;
	/** sample rate for chips created by the engine itself (default 44100) */
	sampleRate?: number;
}

/**
 * Plays sound effect definitions on the same chips as the music, taking channels from it and giving them back
 * (specification section 6). Wrap the chips of a player with `wrapFactory()` (or `attach`) so that their writes go
 * through the engine, then call `play`. Ticks run at the original frame rate and are synchronised on rendered
 * samples: the same sequence of calls gives the same audio, bit for bit.
 *
 * Chips with a driver (YM2149 / AY, SN76489, NES APU, SID) share the chip with the music; every other chip gets a
 * dedicated instance mixed beside the music (no stealing needed).
 */
export class SfxEngine {
	readonly tickRate: number;
	readonly maxVoices: number;
	readonly sampleRate: number;
	private readonly guards: SfxGuard[] = [];
	private readonly dedicated: Chip[] = [];
	private readonly bank = new Map<string, SfxDefinition>();
	private instances: Instance[] = [];
	private nextId = 1;
	private lastTick = -1;
	/**
	 * music volume multiplier while effects play (ducking), 1 = off. It lowers the music on the channels the effects
	 * do not use, for the chips with a driver that supports it (YM2149 / AY, SN76489, NES pulse and noise).
	 */
	duck = 1;
	private duckApplied = 1;

	constructor(options: SfxEngineOptions = {}) {
		this.tickRate = options.tickRate ?? options.region ?? 60;
		this.maxVoices = options.maxVoices ?? 8;
		this.sampleRate = options.sampleRate ?? 44100;
	}

	loadBank(bank: SfxBank): void {
		for (const e of bank.effects) this.bank.set(e.name, e);
	}

	define(def: SfxDefinition): void {
		this.bank.set(def.name, def);
	}

	/** wrap a chip so its writes can be shared with effects; the wrapper replaces the chip in the player */
	attach(chip: Chip): SfxGuard {
		const guard = new SfxGuard(chip, driverFor(chip), this);
		this.guards.push(guard);
		return guard;
	}

	/** a chip factory for the loaders (`chipFactory`) that wraps every chip it creates */
	wrapFactory(
		base: (id: string, o: ChipOptions & Record<string, unknown>) => Chip = createChip,
	): (id: string, o: ChipOptions & Record<string, unknown>) => Chip {
		return (id, o) => this.attach(base(id, o));
	}

	/** chips created for effects of families that cannot share a chip: render them with `renderDedicated` */
	get dedicatedChips(): readonly Chip[] {
		return this.dedicated;
	}

	renderDedicated(left: Float32Array, right: Float32Array, start: number, count: number): void {
		for (const c of this.dedicated) c.render(left, right, start, count);
	}

	isPlaying(name: string): boolean {
		return this.instances.some((i) => i.def.name === name && !i.ended);
	}

	/** true while the effect play with this id (from `play`) is sounding; unknown and ended ids give false */
	isActive(id: number): boolean {
		return this.instances.some((i) => i.id === id && !i.ended);
	}

	stop(id: number): void {
		const inst = this.instances.find((i) => i.id === id);
		if (inst) this.finish(inst);
	}

	stopAll(): void {
		for (const i of [...this.instances]) this.finish(i);
	}

	play(
		name: string,
		options: { volume?: number; pan?: number; pitchOffset?: number; priority?: number; chipIndex?: number } = {},
	): number | null {
		const def = this.bank.get(name);
		if (!def) throw new Error(`unknown sound effect '${name}'`);
		const priority = options.priority ?? def.priority;
		const running = this.instances.filter((i) => i.def === def && !i.ended);
		if (running.length) {
			if (def.retrigger === 'ignore') return null;
			if (def.retrigger === 'restart') for (const r of running) this.finish(r);
		}
		if (this.instances.filter((i) => !i.ended).length >= this.maxVoices) {
			const weakest = this.instances
				.filter((i) => !i.ended)
				.sort((a, b) => a.priority - b.priority || a.id - b.id)[0];
			if (weakest.priority > priority) return null;
			this.finish(weakest);
		}
		const claims: Claim[] = [];
		const inst: Instance = {
			id: this.nextId++,
			def,
			priority,
			tick: 0,
			acc: 0,
			claims,
			volume: options.volume ?? 1,
			pitchOffset: options.pitchOffset ?? 0,
			ended: false,
		};
		const candidates = this.guards.filter((g) => sameFamily(def.chip, familyOf(g.inner)));
		const guard = options.chipIndex !== undefined ? this.guards[options.chipIndex] : candidates[0];
		for (const program of def.voices) {
			if (guard && guard.driver && sameFamily(def.chip, familyOf(guard.inner))) {
				const ch = this.pickChannel(guard, program, priority);
				if (ch < 0) {
					for (const c of claims) c.guard.driver?.release(c.channel);
					return null;
				}
				guard.driver.claim(ch);
				claims.push({ guard, channel: ch, program });
			} else {
				// no shared chip of that family: use an instance of its own
				const chip = this.dedicatedFor(def.chip);
				claims.push({
					guard: null as unknown as SfxGuard,
					channel: typeof program.channel === 'number' ? program.channel : 0,
					program,
					dedicated: chip,
				});
			}
		}
		this.instances.push(inst);
		return inst.id;
	}

	private dedicatedFor(chip: SfxChip): Chip {
		const id = REGISTRY_ID[chip];
		const existing = this.dedicated.find(
			(c) => c.id === (id === 'ay8910' ? 'ym2149' : id === 'nes-apu' ? 'nes-apu' : id),
		);
		if (existing) return existing;
		const created = createChip(id, { sampleRate: this.sampleRate });
		this.dedicated.push(created);
		return created;
	}

	private owners(guard: SfxGuard, channel: number): Instance | undefined {
		return this.instances.find((i) => !i.ended && i.claims.some((c) => c.guard === guard && c.channel === channel));
	}

	/** choose a channel of the guard for a voice program, stealing from a weaker effect when needed; -1 if impossible */
	private pickChannel(guard: SfxGuard, program: SfxVoiceProgram, priority: number): number {
		const n = guard.driver!.channels;
		const order = program.channel === 'any' ? Array.from({ length: n }, (_, i) => i) : [program.channel];
		for (const ch of order) if (ch < n && !this.owners(guard, ch)) return ch;
		let best = -1;
		let bestPriority = Infinity;
		for (const ch of order) {
			if (ch >= n) continue;
			const owner = this.owners(guard, ch);
			if (owner && owner.priority <= priority && owner.priority < bestPriority) {
				best = ch;
				bestPriority = owner.priority;
			}
		}
		if (best >= 0) this.finish(this.owners(guard, best)!);
		return best;
	}

	private finish(inst: Instance): void {
		if (inst.ended) return;
		inst.ended = true;
		for (const c of inst.claims) {
			if (c.dedicated) {
				c.dedicated.write(0, 0);
				continue;
			}
			c.guard.stopPcm(inst.id);
			c.guard.driver!.silence(c.channel);
			c.guard.driver!.release(c.channel);
		}
		this.instances = this.instances.filter((i) => i !== inst);
	}

	/** run tick number `n` (once, whichever guard reaches it first) */
	runTick(n: number): void {
		if (n <= this.lastTick) return;
		this.lastTick = n;
		const duck = this.instances.length ? this.duck : 1;
		if (duck !== this.duckApplied) {
			this.duckApplied = duck;
			for (const g of this.guards) g.driver?.setDuck?.(duck);
		}
		for (const inst of [...this.instances]) {
			if (inst.ended) continue;
			const rate = inst.def.tickRate ?? this.tickRate;
			inst.acc += rate / this.tickRate;
			while (inst.acc >= 1 && !inst.ended) {
				inst.acc -= 1;
				this.stepInstance(inst);
			}
		}
	}

	private stepInstance(inst: Instance): void {
		const t = inst.tick;
		let anyActive = false;
		for (const c of inst.claims) {
			const p = c.program;
			if (p.sample) {
				if (t === 0 && c.guard) c.guard.startPcm(inst.id, c.channel, normalisePcm(p.sample), p.sample.rate);
				if (c.guard?.hasPcm(inst.id)) anyActive = true;
				continue;
			}
			const hzBase = evalCurve(p.pitch, t);
			let hz: number | undefined;
			if (hzBase !== undefined) {
				let note = hzBase + inst.pitchOffset;
				if (p.arpeggio?.length) note += p.arpeggio[t % p.arpeggio.length];
				if (p.vibrato && t >= (p.vibrato.delay ?? 0))
					note +=
						(p.vibrato.depth / 100) *
						Math.sin((2 * Math.PI * (t - (p.vibrato.delay ?? 0))) / Math.max(1, p.vibrato.rate));
				hz = 440 * 2 ** ((note - 69) / 12);
			}
			const vol = evalCurve(p.volume, t);
			const v: VoiceValues = {
				hz,
				rawPeriod: evalCurve(p.rawPeriod, t),
				volume: vol === undefined ? undefined : vol * inst.volume,
				rawVolume: evalCurve(p.rawVolume, t),
				noise: evalCurve(p.noisePeriod, t),
				mix: evalCurve(p.mix, t),
				duty: evalCurve(p.duty, t),
				waveform: p.waveform,
				adsr: p.adsr,
				first: t === 0,
			};
			if (c.guard && c.guard.driver) {
				if (t === 0 && p.envelope && c.guard.driver instanceof AyDriver)
					c.guard.driver.setEnvelope(c.channel, p.envelope.period, p.envelope.shape);
				c.guard.driver.apply(c.channel, v);
			} else if (c.dedicated) this.applyDedicated(c.dedicated, c.channel, p, v, t);
			for (const w of p.writes ?? []) if (w.tick === t) (c.dedicated ?? c.guard.inner).write(w.reg, w.value);
			const finished =
				curveDone(p.pitch, t) &&
				curveDone(p.rawPeriod, t) &&
				curveDone(p.volume, t) &&
				curveDone(p.rawVolume, t) &&
				curveDone(p.noisePeriod, t) &&
				curveDone(p.mix, t) &&
				curveDone(p.duty, t);
			const silent = (v.volume ?? v.rawVolume ?? 1) <= 0 && !p.volume?.loopStart;
			const lastWrite = (p.writes ?? []).some((w) => w.tick > t);
			if (!(finished && silent) || lastWrite) anyActive = true;
			if (p.fm && p.fm.keyOffTick !== undefined && t < p.fm.keyOffTick + 24) anyActive = true;
		}
		inst.tick++;
		const length = inst.def.length;
		if (length !== undefined ? inst.tick >= length : !anyActive) this.finish(inst);
	}

	/** minimal support of the chips without a sharing driver: OPL pitch / key on, PC speaker, raw writes */
	private applyDedicated(chip: Chip, channel: number, p: SfxVoiceProgram, v: VoiceValues, t: number): void {
		if (chip.id === 'opl2' || chip.id === 'opl3') {
			const modOff = [0, 1, 2, 8, 9, 10, 16, 17, 18][channel % 9] + (channel >= 9 ? 0x100 : 0);
			if (p.fm && t === p.fm.keyOnTick - 0 && t === 0) {
				const ops = p.fm.patch.operators;
				ops.forEach((op, i) => {
					const o = modOff + (i ? 3 : 0);
					chip.write(0x20 + o, op[0] ?? 0);
					chip.write(0x40 + o, op[1] ?? 0);
					chip.write(0x60 + o, op[2] ?? 0);
					chip.write(0x80 + o, op[3] ?? 0);
					chip.write(0xe0 + o, op[4] ?? 0);
				});
				chip.write(0xc0 + (channel >= 9 ? 0x100 : 0) + (channel % 9), p.fm.patch.feedbackConnection);
			}
			if (v.hz !== undefined) {
				let block = 0;
				let fnum = Math.round((v.hz * 2 ** 20) / (chip.clock / (chip.id === 'opl3' ? 288 : 72)));
				while (fnum > 1023 && block < 7) {
					fnum >>= 1;
					block++;
				}
				const on = !p.fm || (t >= p.fm.keyOnTick && (p.fm.keyOffTick === undefined || t < p.fm.keyOffTick));
				const bank = channel >= 9 ? 0x100 : 0;
				chip.write(bank + 0xa0 + (channel % 9), fnum & 255);
				chip.write(bank + 0xb0 + (channel % 9), (on ? 0x20 : 0) | (block << 2) | (fnum >> 8));
			}
		} else if (chip.id === 'pc-speaker' && v.hz !== undefined) {
			if (t === 0) chip.write(0x43, 0xb6);
			const div = Math.round(1_193_182 / v.hz);
			chip.write(0x42, div & 255);
			chip.write(0x42, div >> 8);
			chip.write(0x61, (v.volume ?? 15) > 0 ? 3 : 0);
		}
	}
}

/** Render one effect on a fresh chip of its family: the offline path (`renderSfx`, specification 6.C.6) */
export function renderSfx(
	def: SfxDefinition,
	seconds: number,
	options: { sampleRate?: number; region?: Region; clock?: number } = {},
): { left: Float32Array; right: Float32Array; sampleRate: number } {
	const sampleRate = options.sampleRate ?? 44100;
	const region = options.region ?? Region.NTSC;
	const engine = new SfxEngine({ region, sampleRate });
	const pal = region === Region.PAL;
	const clocks: Partial<Record<SfxChip, number>> = {
		ym2149: 2_000_000,
		ay8910: 1_773_400,
		sn76489: pal ? 3_546_893 : 3_579_545,
		nes: pal ? 1_662_607 : 1_789_773,
		sid: pal ? 985_248 : 1_022_727,
	};
	const chipOptions: Record<string, unknown> = { sampleRate };
	const clock = options.clock ?? clocks[def.chip];
	if (clock) chipOptions.clock = clock;
	if (def.chip === 'nes') chipOptions.standard = pal ? 'pal' : 'ntsc';
	const guard = engine.attach(createChip(REGISTRY_ID[def.chip], chipOptions));
	engine.define(def);
	engine.play(def.name);
	const n = Math.floor(seconds * sampleRate);
	const left = new Float32Array(n);
	const right = new Float32Array(n);
	guard.render(left, right, 0, n);
	engine.renderDedicated(left, right, 0, n);
	return { left, right, sampleRate };
}

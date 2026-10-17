import type { Chip } from '../chips/Chip.ts';
import { loadFile, type LoadFileOptions } from '../formats/load.ts';
import type { RetroPlayer } from '../players/Player.ts';
import { Region } from '../region.ts';
import { SfxEngine } from './engine.ts';
import type { SoundtrackProject } from './types.ts';

export interface SoundtrackOptions {
	sampleRate?: number;
	/** returns the bytes of a music file named in the project */
	load: (path: string) => Promise<Uint8Array>;
	/** options handed to `loadFile` for the music (song number, Amiga clock...) */
	music?: Omit<LoadFileOptions, 'sampleRate' | 'chipFactory' | 'name'>;
	/** loop the music (default true) */
	loop?: boolean;
	/** music lowered by this factor while effects play (see `SfxEngine.duck`) */
	duck?: number;
}

/**
 * Runs a `SoundtrackProject` as the original game's sound driver did: a command number starts a piece of music or a
 * sound effect (`trigger`), music is played by its player and effects are mixed on the same chips. This is the
 * "rebuild a whole game soundtrack" object of specification section 6.D.
 */
export class SoundtrackPlayer {
	readonly sampleRate: number;
	private readonly loaded = new Map<string, Uint8Array>();
	private engine: SfxEngine;
	private player: RetroPlayer | null = null;
	private current: string | null = null;

	constructor(
		readonly project: SoundtrackProject,
		private readonly options: SoundtrackOptions,
	) {
		this.sampleRate = options.sampleRate ?? 44100;
		this.engine = this.newEngine();
	}

	private newEngine(): SfxEngine {
		const engine = new SfxEngine({
			region: this.project.region === 'PAL' ? Region.PAL : Region.NTSC,
			sampleRate: this.sampleRate,
		});
		engine.loadBank(this.project.bank);
		if (this.options.duck !== undefined) engine.duck = this.options.duck;
		return engine;
	}

	/** fetch every music file of the project */
	async load(): Promise<void> {
		for (const [id, path] of Object.entries(this.project.music)) this.loaded.set(id, await this.options.load(path));
	}

	/** id of the music playing, if any */
	get playing(): string | null {
		return this.current;
	}

	/** start music by id (effects of the previous music are cut: they share its chips) */
	playMusic(id: string): void {
		const bytes = this.loaded.get(id);
		if (!bytes) throw new Error(`music '${id}' is not loaded (call load() first)`);
		this.engine.stopAll();
		this.engine = this.newEngine();
		this.player = loadFile(bytes, {
			...this.options.music,
			name: this.project.music[id],
			sampleRate: this.sampleRate,
			chipFactory: this.engine.wrapFactory(),
			loop: this.options.loop ?? true,
		});
		this.current = id;
	}

	stopMusic(): void {
		this.player = null;
		this.current = null;
	}

	/** run a command number of the original sound driver; returns false for an unknown command */
	trigger(command: number): boolean {
		const t = this.project.triggers[command];
		if (!t) return false;
		if (t.kind === 'music') this.playMusic(t.id);
		else this.engine.play(t.id);
		return true;
	}

	/** ADD `count` frames of music + effects into the buffers */
	render(left: Float32Array, right: Float32Array, start: number, count: number): void {
		this.player?.render(left, right, start, count);
		this.engine.renderDedicated(left, right, start, count);
	}

	/** the chips of the current music (muting, inspection) */
	get chips(): readonly Chip[] {
		return this.player?.chips ?? [];
	}
}

/**
 * Offline rendering of a soundtrack: `timeline` lists the commands and when they arrive (seconds); the result is the
 * stereo audio of `seconds` seconds, to compare against a capture of the original game.
 */
export async function renderSoundtrack(
	project: SoundtrackProject,
	timeline: readonly { at: number; command: number }[],
	seconds: number,
	options: SoundtrackOptions,
): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
	const sp = new SoundtrackPlayer(project, options);
	await sp.load();
	const rate = sp.sampleRate;
	const total = Math.floor(seconds * rate);
	const left = new Float32Array(total);
	const right = new Float32Array(total);
	const events = [...timeline].sort((a, b) => a.at - b.at);
	let pos = 0;
	for (const e of events) {
		const at = Math.min(total, Math.floor(e.at * rate));
		if (at > pos) {
			sp.render(left, right, pos, at - pos);
			pos = at;
		}
		sp.trigger(e.command);
	}
	if (total > pos) sp.render(left, right, pos, total - pos);
	return { left, right, sampleRate: rate };
}

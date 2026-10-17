/**
 * Hands out the voices (channels) of a chip to notes: the first free one, else the oldest voice is stolen.
 */
export class VoiceAllocator {
	private readonly notes: number[];
	private readonly age: number[];
	private clock = 0;

	constructor(readonly voices: number) {
		this.notes = new Array(voices).fill(-1);
		this.age = new Array(voices).fill(0);
	}

	/** the voice for `note`: the one already playing it (retrigger), a free one, or the oldest (stolen) */
	take(note: number): { voice: number; stolen: boolean; stolenNote?: number } {
		let voice = this.notes.indexOf(note);
		let stolen = false;
		if (voice < 0) voice = this.notes.indexOf(-1);
		if (voice < 0) {
			voice = 0;
			for (let v = 1; v < this.voices; v++) if (this.age[v] < this.age[voice]) voice = v;
			stolen = true;
		}
		const stolenNote = stolen ? this.notes[voice] : undefined;
		this.notes[voice] = note;
		this.age[voice] = ++this.clock;
		return { voice, stolen, stolenNote };
	}

	/** free the voice playing `note`; returns it, or -1 when no voice plays that note */
	release(note: number): number {
		const voice = this.notes.indexOf(note);
		if (voice >= 0) this.notes[voice] = -1;
		return voice;
	}

	/** the note a voice plays, or -1 */
	noteOf(voice: number): number {
		return this.notes[voice];
	}

	/** the voices playing a note now */
	active(): { voice: number; note: number }[] {
		const out: { voice: number; note: number }[] = [];
		for (let v = 0; v < this.voices; v++) if (this.notes[v] >= 0) out.push({ voice: v, note: this.notes[v] });
		return out;
	}

	clear(): void {
		this.notes.fill(-1);
	}
}

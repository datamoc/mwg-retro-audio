/** Seeded pseudo random generator (mulberry32): the same seed always gives the same music */
export class Random {
	private state: number;

	constructor(seed: number | string) {
		let h = 0x811c9dc5;
		for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
		this.state = h >>> 0;
	}

	/** float in [0, 1) */
	next(): number {
		this.state = (this.state + 0x6d2b79f5) >>> 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** integer in [0, n) */
	int(n: number): number {
		return Math.floor(this.next() * n);
	}

	pick<T>(items: readonly T[]): T {
		return items[this.int(items.length)];
	}

	chance(probability: number): boolean {
		return this.next() < probability;
	}
}

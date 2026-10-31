export type Mode = 'major' | 'minor' | 'dorian' | 'mixolydian' | 'phrygian';

/** Waveform family of a voice; the chip of a style limits which ones it uses */
export type Timbre = 'saw' | 'pulse' | 'square' | 'triangle' | 'fm';

/** Drum groove: one 16 step string per voice (`x` hit, `X` accent), and the bass step pattern (R root, O octave, F fifth) */
export interface Groove {
	kick: string;
	snare: string;
	hat: string;
	openHat: string;
	/** optional tom hits, for slow heavy grooves */
	tom?: string;
	bass: string;
}

/** How busy and how loud the parts are, to set a mood without changing the sound of the era */
export interface Feel {
	/** share of the lead motif steps that are played, 0..1 */
	leadDensity: number;
	/** octave shift of the lead and of the bass */
	leadOctave: number;
	bassOctave: number;
	/** level of the drums and of the chords relative to the default (1) */
	drumLevel: number;
	chordLevel: number;
}

export const DEFAULT_FEEL: Feel = { leadDensity: 0.7, leadOctave: 0, bassOctave: 0, drumLevel: 1, chordLevel: 1 };

export interface StyleSpec {
	id: string;
	name: string;
	/** tempo in beats per minute: the exact target of every cue of the style */
	tempo: number;
	/** pitch class of the tonic, 0 = C */
	tonic: number;
	mode: Mode;
	/** the sound source being imitated; sets polyphony and character */
	chip: 'disco-analog' | 'opl2' | 'psg' | 'amiga';
	instruments: {
		bass: Timbre;
		lead: Timbre;
		/** how the harmony is played: sustained pad, offbeat stabs, or arpeggio (one voice chips) */
		chords: 'pad' | 'stabs' | 'arpeggio';
		/** a sung or spoken vocoder voice line */
		voice: 'vocoder' | 'none';
	};
	groove: Groove;
	/** mood of the parts, see `Feel` (defaults to `DEFAULT_FEEL`) */
	feel?: Partial<Feel>;
	/** tone of the whole mix: gain in dB of a low shelf (below about 220 Hz) and of a high shelf (above about 2.5 kHz) */
	eq?: { low: number; high: number };
	/**
	 * The tone colour of the style: the average spectrum of its era in 32 log spaced bands (60 Hz .. 9.9 kHz, level
	 * removed, see `meanBandShape`), a statistic measured on reference recordings and smoothed, with no audio in it.
	 * The mix is moved towards it with a matching EQ
	 */
	toneTarget?: readonly number[];
	/** the largest band shape distance from `toneTarget` that still counts as the tone of the style (default 0.6) */
	toneTolerance?: number;
	/** acceptable range of the average spectral centroid of a cue, in Hz */
	centroidRange: readonly [number, number];
}

const FOUR_ON_FLOOR: Groove = {
	kick: 'x...x...x...x...',
	snare: '....x.......x...',
	hat: 'x.x.x.x.x.x.x.x.',
	openHat: '..x...x...x...x.',
	bass: 'R.RO.R.RR.RO.RF.',
};

const MARCH: Groove = {
	kick: 'x.......x.......',
	snare: '....x.......x...',
	hat: 'x.x.x.x.x.x.x.x.',
	openHat: '................',
	bass: 'R.R.R.R.R.R.R.R.',
};

const BREAK: Groove = {
	kick: 'x..x..x...x..x..',
	snare: '....x.......x..x',
	hat: 'x.xxx.xxx.xxx.xx',
	openHat: '................',
	bass: 'R..R..O.R.R..F..',
};

const HALF_TIME: Groove = {
	kick: 'x.......x.x.....',
	snare: '........x.......',
	hat: 'x.x.x.x.x.x.x.x.',
	openHat: '..............x.',
	bass: 'R.......R.R.O...',
};

const AMBIENT: Groove = {
	kick: 'x...............',
	snare: '................',
	hat: '....x.......x...',
	openHat: '................',
	bass: 'R.......R.......',
};

const DUNGEON: Groove = {
	kick: 'x.......x.......',
	snare: '................',
	hat: '................',
	openHat: '................',
	tom: '........x.....x.',
	bass: 'R...............',
};

const DRIVE: Groove = {
	kick: 'x..xx.x.x..xx.x.',
	snare: '....x.......x...',
	hat: 'xxxxxxxxxxxxxxxx',
	openHat: '..............x.',
	bass: 'RRORRORRRRORRORF',
};

const VICTORY: Groove = {
	kick: 'x...x...x...x...',
	snare: '....x.......x.x.',
	hat: 'x.x.x.x.x.x.x.x.',
	openHat: '..x...x...x...x.',
	bass: 'R.RR.R.RR.RR.RF.',
};

/** Original style descriptions: tempo, key, instrumentation and groove typical of an era, no existing tune */
export const STYLES: Readonly<Record<string, StyleSpec>> = {
	'disco-vocoder-1979': {
		id: 'disco-vocoder-1979',
		name: 'Late 1970s disco with a vocoder voice',
		tempo: 118,
		tonic: 9,
		mode: 'dorian',
		chip: 'disco-analog',
		instruments: { bass: 'saw', lead: 'saw', chords: 'stabs', voice: 'vocoder' },
		groove: FOUR_ON_FLOOR,
		toneTarget: [
			3.7, 3.69, 3.55, 3.31, 3.05, 2.72, 2.28, 1.81, 1.39, 0.99, 0.63, 0.41, 0.36, 0.38, 0.33, 0.08, -0.39, -0.91,
			-1.27, -1.47, -1.55, -1.53, -1.56, -1.73, -1.91, -2.03, -2.14, -2.24, -2.32, -2.4, -2.55, -2.68,
		],
		centroidRange: [500, 3200],
	},
	'dos-opl2-1987': {
		id: 'dos-opl2-1987',
		name: 'DOS game, AdLib / OPL2 FM, 1987',
		tempo: 140,
		tonic: 4,
		mode: 'minor',
		chip: 'opl2',
		instruments: { bass: 'fm', lead: 'fm', chords: 'pad', voice: 'none' },
		groove: MARCH,
		toneTarget: [
			0.97, 1.63, 2.36, 2.53, 2.28, 2.28, 2.53, 2.5, 2.18, 1.96, 1.82, 1.55, 1.21, 0.93, 0.69, 0.47, 0.25, -0.0,
			-0.25, -0.47, -0.72, -0.99, -1.24, -1.44, -1.66, -1.99, -2.4, -2.78, -3.1, -3.41, -3.73, -3.96,
		],
		centroidRange: [600, 3600],
	},
	'atari-st-psg-1987': {
		id: 'atari-st-psg-1987',
		name: 'Atari ST, three voice PSG, 1987',
		tempo: 150,
		tonic: 7,
		mode: 'major',
		chip: 'psg',
		instruments: { bass: 'square', lead: 'pulse', chords: 'arpeggio', voice: 'none' },
		groove: BREAK,
		centroidRange: [800, 4200],
	},
	'amiga-tracker-1988': {
		id: 'amiga-tracker-1988',
		name: 'Amiga tracker, 4 channel sample style, 1988',
		tempo: 125,
		tonic: 0,
		mode: 'mixolydian',
		chip: 'amiga',
		instruments: { bass: 'triangle', lead: 'pulse', chords: 'stabs', voice: 'none' },
		groove: HALF_TIME,
		centroidRange: [400, 3000],
	},
};

/** Semitone steps of each mode from its tonic */
export const SCALES: Readonly<Record<Mode, readonly number[]>> = {
	major: [0, 2, 4, 5, 7, 9, 11],
	minor: [0, 2, 3, 5, 7, 8, 10],
	phrygian: [0, 1, 3, 5, 7, 8, 10],
	dorian: [0, 2, 3, 5, 7, 9, 10],
	mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/** A mood for a game situation, applied on top of an era style: it changes the music, not the sound of the era */
export interface Scene {
	id: string;
	name: string;
	tempo: number;
	mode: Mode;
	groove: Groove;
	chords: StyleSpec['instruments']['chords'];
	feel: Partial<Feel>;
	centroidRange?: readonly [number, number];
	/** a mood may depart from the average tone of the era: how far (measured on the cues of every era, with a margin) */
	toneTolerance: number;
}

export const SCENES: Readonly<Record<string, Scene>> = {
	forest: {
		id: 'forest',
		name: 'Forest: slow, open, airy',
		tempo: 92,
		mode: 'mixolydian',
		groove: AMBIENT,
		chords: 'pad',
		feel: { leadDensity: 0.45, drumLevel: 0.5, chordLevel: 1.5 },
		centroidRange: [250, 3400],
		toneTolerance: 1.2,
	},
	dungeon: {
		id: 'dungeon',
		name: 'Dungeon: slow, dark, sparse',
		tempo: 76,
		mode: 'phrygian',
		groove: DUNGEON,
		chords: 'pad',
		feel: { leadDensity: 0.25, leadOctave: -1, bassOctave: -1, drumLevel: 1, chordLevel: 1.5 },
		centroidRange: [150, 3200],
		toneTolerance: 1.7,
	},
	village: {
		id: 'village',
		name: 'Village: light, steady, bright',
		tempo: 108,
		mode: 'major',
		groove: MARCH,
		chords: 'arpeggio',
		feel: { leadDensity: 0.75, drumLevel: 0.6 },
		centroidRange: [400, 3800],
		toneTolerance: 1.1,
	},
	fight: {
		id: 'fight',
		name: 'Fight: fast, dense, driving',
		tempo: 164,
		mode: 'minor',
		groove: DRIVE,
		chords: 'stabs',
		feel: { leadDensity: 0.9, drumLevel: 1.4 },
		centroidRange: [400, 4200],
		toneTolerance: 0.9,
	},
	boss: {
		id: 'boss',
		name: 'Boss: heavy, tense, low',
		tempo: 148,
		mode: 'phrygian',
		groove: DRIVE,
		chords: 'stabs',
		feel: { leadDensity: 0.85, bassOctave: -1, drumLevel: 1.5 },
		centroidRange: [300, 4000],
		toneTolerance: 0.9,
	},
	victory: {
		id: 'victory',
		name: 'Victory: upbeat and high',
		tempo: 128,
		mode: 'major',
		groove: VICTORY,
		chords: 'stabs',
		feel: { leadDensity: 0.85, leadOctave: 1 },
		centroidRange: [500, 4200],
		toneTolerance: 0.9,
	},
};

/** A style with a scene applied: the scene sets the tempo, mode, groove, chords and feel; the era keeps its voices and tone */
export function applyScene(style: StyleSpec, scene: Scene): StyleSpec {
	return {
		...style,
		id: `${style.id}+${scene.id}`,
		name: `${style.name} / ${scene.name}`,
		tempo: scene.tempo,
		mode: scene.mode,
		groove: scene.groove,
		instruments: { ...style.instruments, chords: scene.chords },
		feel: { ...style.feel, ...scene.feel },
		centroidRange: scene.centroidRange ?? style.centroidRange,
		toneTolerance: scene.toneTolerance,
	};
}

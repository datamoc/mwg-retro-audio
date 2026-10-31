export { composeCue, type ComposeHooks, type ComposeOptions, type Cue } from './composeCue.ts';
export { composeCueAsync, composeNotesAsync } from './async.ts';
export {
	composeNotes,
	foldLoop,
	scoreToMidiFile,
	type LoopedBuffer,
	type Score,
	type ScoreOptions,
	type StereoBuffer,
} from './score.ts';
export { checkCue, meanCentroid, styleProfile, type CueCheck, type StyleProfile } from './profile.ts';
export {
	applyScene,
	DEFAULT_FEEL,
	SCALES,
	SCENES,
	STYLES,
	type Feel,
	type Groove,
	type Mode,
	type Scene,
	type StyleSpec,
	type Timbre,
} from './styles.ts';
export { Random } from './random.ts';

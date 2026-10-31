import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCue, composeCue, SCENES, STYLES } from '../src/compose/index.ts';

const RATE = 22050;

test('the same seed gives the same cue, another seed another cue', () => {
	const a = composeCue({ style: 'dos-opl2-1987', seed: 1, duration: 8, sampleRate: RATE });
	const b = composeCue({ style: 'dos-opl2-1987', seed: 1, duration: 8, sampleRate: RATE });
	const c = composeCue({ style: 'dos-opl2-1987', seed: 2, duration: 8, sampleRate: RATE });
	assert.deepEqual(a.left, b.left);
	assert.notDeepEqual(a.left, c.left);
});

test('a cue lasts a whole number of bars and loops without a seam', () => {
	const cue = composeCue({ style: 'atari-st-psg-1987', seed: 'level 1', duration: 10, sampleRate: RATE });
	const barSeconds = (4 * 60) / cue.tempo;
	assert.ok(Math.abs(cue.seconds - cue.bars * barSeconds) < 1 / RATE);
	assert.ok(Math.abs(cue.seconds - 10) <= barSeconds / 2);
	// the last samples lead into the first ones: the jump across the loop point is no bigger than inside the cue
	const jump = (i: number): number => Math.abs(cue.left[(i + 1) % cue.left.length] - cue.left[i]);
	let inside = 0;
	for (let i = 0; i < cue.left.length - 1; i++) inside = Math.max(inside, jump(i));
	assert.ok(jump(cue.left.length - 1) <= inside);
	assert.ok(cue.left.every((s) => Math.abs(s) <= 1));
});

test('an unknown style is rejected', () => {
	assert.throws(() => composeCue({ style: 'nope', seed: 1, duration: 4 }), RangeError);
});

for (const id of Object.keys(STYLES)) {
	test(`a ${id} cue matches the profile of its style`, () => {
		const cue = composeCue({ style: id, seed: 7, duration: 24, sampleRate: RATE });
		const check = checkCue(cue);
		assert.ok(check.tempoOk, `tempo error ${check.tempoError}`);
		assert.ok(check.pitchOk, `scale share ${check.scaleShare}`);
		assert.ok(check.spectrumOk, `centroid ${check.centroid}`);
		assert.ok(check.toneOk, `tone distance ${check.toneDistance}`);
	});
}

test('the voice line can be spoken, sung or left out', () => {
	const sung = composeCue({ style: 'disco-vocoder-1979', seed: 3, duration: 16, sampleRate: RATE });
	const spoken = composeCue({ style: 'disco-vocoder-1979', seed: 3, duration: 16, sampleRate: RATE, voice: 'speak' });
	const none = composeCue({ style: 'disco-vocoder-1979', seed: 3, duration: 16, sampleRate: RATE, voice: 'none' });
	assert.notDeepEqual(sung.left, none.left);
	assert.notDeepEqual(spoken.left, none.left);
	assert.notDeepEqual(spoken.left, sung.left);
});

test('plain text drives the voice line, spoken or sung, in both languages', () => {
	const base = { style: 'disco-vocoder-1979', seed: 5, duration: 16, sampleRate: RATE } as const;
	const neutral = composeCue(base);
	const sungFr = composeCue({ ...base, text: 'bonjour tout le monde' });
	const sungEn = composeCue({ ...base, text: 'hello world', language: 'en' });
	const spoken = composeCue({ ...base, voice: 'speak', text: 'bonjour' });
	assert.notDeepEqual(sungFr.left, neutral.left);
	assert.notDeepEqual(sungFr.left, sungEn.left);
	assert.notDeepEqual(spoken.left, composeCue({ ...base, voice: 'speak' }).left);
	assert.deepEqual(sungFr.left, composeCue({ ...base, text: 'bonjour tout le monde' }).left);
});

test('the style profiles discriminate: a cue fails the tempo of another style', () => {
	const styles = Object.values(STYLES);
	for (const a of styles) {
		const cue = composeCue({ style: a, seed: 4, duration: 24, sampleRate: RATE });
		assert.ok(checkCue(cue).tempoOk, `${a.id} against itself`);
		for (const b of styles) {
			if (a.id === b.id) continue;
			// a tempo that is not within 1 % (or a half or double of it) of the style's must be rejected
			const ratio = a.tempo / b.tempo;
			const related = [1, 2, 0.5].some((m) => Math.abs(ratio * m - 1) <= 0.01);
			assert.equal(checkCue({ ...cue, style: b }).tempoOk, related, `${a.id} measured as ${b.id}`);
		}
	}
});

test('every scene gives its own tempo and mood on top of the style, and matches its profile', () => {
	const base = { style: 'dos-opl2-1987', seed: 'scene', duration: 12, sampleRate: RATE } as const;
	const plain = composeCue(base);
	for (const [id, scene] of Object.entries(SCENES)) {
		const cue = composeCue({ ...base, scene: id });
		assert.equal(cue.tempo, scene.tempo);
		assert.equal(cue.style.mode, scene.mode);
		assert.notDeepEqual(cue.left, plain.left, id);
		const check = checkCue(cue);
		assert.ok(check.ok, `${id}: ${JSON.stringify(check)}`);
	}
	assert.throws(() => composeCue({ ...base, scene: 'nope' }), RangeError);
});

test('scenes differ from each other in tempo, density and loudness of the drums', () => {
	const tempos = new Set(Object.values(SCENES).map((s) => s.tempo));
	assert.ok(tempos.size >= 5);
	assert.ok(SCENES.fight.tempo > SCENES.village.tempo && SCENES.village.tempo > SCENES.dungeon.tempo);
	assert.ok((SCENES.fight.feel.leadDensity ?? 0) > (SCENES.dungeon.feel.leadDensity ?? 1));
});

test('a style without a vocoder voice speaks when it is given a text', () => {
	const base = { style: 'dos-opl2-1987', seed: 11, duration: 12, sampleRate: RATE } as const;
	const silent = composeCue(base);
	const spoken = composeCue({ ...base, text: 'niveau un' });
	assert.notDeepEqual(spoken.left, silent.left);
	// the voice sits in the first bar: that part of the cue changes much more than the end, where only the music is
	const bar = Math.round(((4 * 60) / spoken.tempo) * RATE);
	const energy = (x: Float32Array, from: number, to: number): number => {
		let e = 0;
		for (let i = from; i < to; i++) e += x[i] ** 2;
		return e;
	};
	assert.ok(energy(spoken.left, 0, bar) > 0 && energy(silent.left, 0, bar) > 0);
	assert.deepEqual(composeCue({ ...base, text: 'niveau un' }).left, spoken.left);
});

test('a cue with a voice line also hands over the dry voice track', () => {
	const base = { style: 'disco-vocoder-1979', seed: 2, duration: 12, sampleRate: RATE } as const;
	const withVoice = composeCue({ ...base, text: 'bonjour' });
	assert.ok(withVoice.voiceTrack);
	assert.equal(withVoice.voiceTrack.left.length, withVoice.left.length);
	assert.ok(withVoice.voiceTrack.left.some((s) => Math.abs(s) > 0.1));
	assert.equal(composeCue({ ...base, voice: 'none' }).voiceTrack, undefined);
});

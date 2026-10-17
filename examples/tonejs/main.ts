import type * as ToneTypes from 'tone';
import { loadFile } from '../../src/formats/load.ts';
import { createToneStream } from '../../src/driver/tone.ts';
import { demoYm } from './melody.ts';

const play = document.querySelector<HTMLButtonElement>('#play')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const volume = document.querySelector<HTMLInputElement>('#volume')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
let cleanup: (() => void) | undefined;
let output: ToneTypes.Volume | undefined;
let audioContext: AudioContext | undefined;

function finish(): void {
	cleanup?.();
	cleanup = undefined;
	output = undefined;
	play.disabled = false;
	stop.disabled = true;
	status.value = 'Arrêté ; les sources et effets ont été libérés.';
}

play.addEventListener('click', async () => {
	play.disabled = true;
	try {
		audioContext ??= new AudioContext();
		await audioContext.resume();
		const Tone = await import('tone');
		Tone.setContext(audioContext);
		await Tone.start();
		const context = Tone.getContext().rawContext;
		output = new Tone.Volume(Number(volume.value)).toDestination();
		const delay = new Tone.FeedbackDelay(0.25, 0.2).connect(output);
		delay.wet.value = 0.2;
		const bass = new Tone.Synth().connect(output);
		const player = loadFile(demoYm(), { sampleRate: context.sampleRate });
		const retro = createToneStream(Tone, delay, player, { loop: true });
		const transport = Tone.getTransport();
		transport.bpm.value = 120;
		let note = 0;
		const sequence = transport.scheduleRepeat((time) => {
			bass.triggerAttackRelease(['C2', 'F2', 'G2', 'C2'][note++ % 4], '8n', time, 0.25);
		}, '2n');
		const start = Tone.now() + 0.15;
		player.reset();
		retro.stream.start(start);
		transport.start(start, 0);
		cleanup = () => {
			transport.stop();
			transport.clear(sequence);
			retro.dispose();
			bass.dispose();
			delay.dispose();
			output?.dispose();
		};
		stop.disabled = false;
		status.value = `Lecture : Tone.js ${Tone.version}, ${context.sampleRate} Hz, contexte partagé.`;
	} catch (error) {
		finish();
		status.value = `Impossible de démarrer : ${String(error)}`;
	}
});
stop.addEventListener('click', finish);
volume.addEventListener('input', () => {
	document.querySelector('#level')!.textContent = `${volume.value} dB`;
	output?.volume.rampTo(Number(volume.value), 0.03);
});
window.addEventListener('pagehide', finish);

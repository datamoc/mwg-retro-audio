# Using retro audio with MWG

This integration targets `@datamoc/mwg` **0.52.1 and later in the 0.52 series** (`^0.52.1`), the published version checked on 31 October 2026.
Install both packages in a consuming application:

```sh
npm install @datamoc/mwg@^0.52.1 @datamoc/mwg-retro-audio
```

Development tests against the published `@datamoc/mwg` 0.52.1 package. MWG remains an optional
peer: the retro adapters import only its types, so standalone chip playback does not need the framework.

## Choose the playback path

| Use | Adapter | Cost and ownership |
| --- | --- | --- |
| Long or looping BGM/BGS | `retroStreamLoader` with `AudioBus.stream` | Synthesizes short chunks on demand; MWG owns looping, pause/resume, mixing and saves |
| Short effects and jingles | `retroBusLoader` with `AudioBus.load` | Renders once per request; a stereo 44.1 kHz float buffer uses about 353 kB per second |
| Crossfades controlled by `Music` | `retroPlayableFactory` | Uses the retro streaming driver behind MWG's `Playable` contract |
| Custom streaming controls | `retroBlockSource` and `retroLoopRegion` | Hand a player to `StreamChannel` or `StreamPlayable` |
| Expensive MIDI engines | MWG `playMidiHosted` with a packaged retro worker core | Moves synthesis to a worker when available; inspect the actual host mode |

Streaming bounds decoded PCM memory, but still keeps the parsed file and synthesizer state. It does not move chip
emulation off the main thread. Seeking resets the player and emulates the skipped audio, so a distant seek can be
expensive. Choose hosted MIDI or an offline render for engines that exceed your frame budget.

## Stream music through the bus

```ts
import { AudioBus } from '@datamoc/mwg/audio';
import { retroBusLoader, retroStreamLoader } from '@datamoc/mwg-retro-audio/mwg';

const context = new AudioContext();
const options = { context, locate: (_kind: string, name: string) => `audio/${name}` };
const bus = new AudioBus(context, {
	stream: retroStreamLoader(options),
	load: retroBusLoader({ ...options, maxSeconds: 30 }),
});

// Run after a user gesture, so the browser allows audio.
await context.resume();
await bus.playBgm({ name: 'town.ym', volume: 80 });
await bus.playSe({ name: 'door.voc', volume: 90 });
// At teardown:
bus.stopAll();
```

The stream loader is asked only for BGM/BGS. It returns a fresh player for each request, at the context's sample
rate, with internal looping disabled. MWG repeats from the file's loop point to its end, or repeats the whole
source when a finite file has no loop point. Unknown-length sources keep playing until stopped or until their
renderer ends. No five-minute render limit is imposed on the streaming path.

Both loaders return `null` for excluded paths, fetch failures and unsupported files. `retroStreamLoader` returning
`null` lets MWG try `load`. To use native Ogg/MP3 and MIDI alongside retro files, route assets with `locate` and use
MWG's `createAudioLoader` as the buffered fallback. Its `budget` option bounds cached decoded buffers.

For embedded MWG resources, inject a byte reader instead of fetching URLs:

```ts
import { getBinary, loadBinary } from '@datamoc/mwg/assets/binary';

const fetchBytes = async (path: string, signal?: AbortSignal): Promise<Uint8Array> => {
	signal?.throwIfAborted();
	await loadBinary([path]);
	signal?.throwIfAborted();
	return new Uint8Array(getBinary(path));
};
// Pass fetchBytes to either retro loader, along with context and locate.
```

The default fetcher forwards MWG's `AbortSignal` to `fetch`. Custom readers receive that same signal. Both paths
skip parsing when superseded while fetching, and report load progress at 0, 0.5 and 1. Buffered rendering is
synchronous; cancellation cannot interrupt a render already running. Streaming loaders do not cache mutable
players: sharing a source across channels would also share its playhead.

## Keep only the instruments you use

```ts
import { registerMidiSynth } from '@datamoc/mwg/audio';
import { instrumentMidiEngines } from '@datamoc/mwg-retro-audio/mwg';
import { psgInstruments } from '@datamoc/mwg-retro-audio/instruments/psg';

for (const [name, factory] of Object.entries(instrumentMidiEngines(psgInstruments))) {
	registerMidiSynth(name, factory);
}
```

Use targeted instrument modules and individual worker cores. `/mwg/catalogue` and `/mwg/worker-cores` intentionally
include all engines and are appropriate for tools that offer every model. `npm run check:bundles` verifies that
targeted registration does not retain the catalogue. Registration alone does not move synthesis to a worker.

## Host a heavy MIDI engine

```ts
import { StreamChannel, parseMidi, playMidiHosted } from '@datamoc/mwg/audio';
import d50Core from '@datamoc/mwg-retro-audio/mwg/worker-cores/retro-d50';

declare const context: AudioContext;
declare const midiBytes: ArrayBuffer;

const playing = playMidiHosted(parseMidi(midiBytes), {
	sampleRate: context.sampleRate,
	factorySource: d50Core,
	channel: new StreamChannel(context),
});
console.log(playing.host.stats().mode);
// At teardown:
playing.stop();
```

The bundled source is necessary because a function that imports a synthesizer cannot be serialized with its
module dependencies. MWG may fall back to the main thread when workers are unavailable. Measure representative
polyphony with `mwg-audio bench` and watch `onAudioUnderrun`; avoid assuming that chunked playback is cheap enough
for every engine. See [the integration requirements](MWG-REQUIREMENTS.md) for
historical measurements and fidelity limits. Hosted MIDI queues channel messages; do not assume it loads a SysEx
patch bank from the file automatically.

For standard MIDI with a SoundFont, MWG 0.49 and later's `renderMidiToBufferAsync` accepts `decode` for compressed embedded
SoundFont 3 samples. Prefer that native route when retro chip emulation is not needed.

## Render a MIDI file off the main thread

MWG 0.50 and later construct and run a named engine on a worker in `renderMidiToBufferAsync`, provided it was
registered with a third `workerFactory` argument. `registerRetroWorkerMidiEngines` does it from the packaged cores:

```ts
import { registerMidiSynth, renderMidiToBufferAsync } from '@datamoc/mwg/audio';
import { retroMidiEngines, registerRetroWorkerMidiEngines } from '@datamoc/mwg-retro-audio/mwg';
import { retroCoreSource } from '@datamoc/mwg-retro-audio/mwg/worker-cores';

declare const midiBytes: ArrayBuffer;
declare const signal: AbortSignal;

registerRetroWorkerMidiEngines(registerMidiSynth, retroMidiEngines, retroCoreSource);
const track = await renderMidiToBufferAsync(midiBytes, { synth: 'retro:d50', signal });
```

The result equals `renderMidiToBuffer` sample for sample (`tests/mwg-worker-engines.test.ts` checks `retro:mt32`,
`retro:dx7` and `retro:d50`), and `signal` cancels it. An engine without a core stays on the calling thread; a worker
failure falls back as usual and fires `onMidiSynthFallback`. `retroCoreSource` holds every core: for a small bundle,
import one `.../worker-cores/<name>` text and pass a lookup that returns it. Registering with
`registerRetroMidiEngines` alone keeps synthesis on the calling thread.

### Notes made by code or recorded at a keyboard

`renderNotesAsync` takes timed channel messages (`{ time, status, data1, data2 }`, `time` in seconds), such as a
recording or a phrase generated by code, and renders them to samples the same way:

```ts
import * as audio from '@datamoc/mwg/audio';
import { renderNotesAsync } from '@datamoc/mwg-retro-audio/mwg';

const notes = [
	{ time: 0, status: 0x90, data1: 60, data2: 100 },
	{ time: 0.5, status: 0x80, data1: 60, data2: 0 },
];
const rendered = await renderNotesAsync(audio, notes, { synth: 'retro:d50', signal });
const buffer = audio.toAudioBuffer(context, rendered); // play it, or loop it with rendered.loopStart / loopEnd
```

MWG's `midiFileFromTimedMessages` (0.52 and later) turns the notes into a `MidiFile` with times kept to the
microsecond, so no Standard MIDI File is written and parsed in between; `scoreToMidiFile` and `writeSmf` remain for
exporting a file. MWG's `renderMidiToBufferAsync` has no progress callback (its options are `signal`,
`synth`, `soundFontBytes`, `decode`, `missingProgram`, `channels`, `sampleRate`, `gain` and `maxDuration`, and
`spawn` has no way for a worker to report back), so a render by MWG can be cancelled but not followed. The workers
below, which this package owns, do report progress.

### Compose and render files in a worker

```ts
import { composeCueAsync, composeNotesAsync, foldLoop, renderFileAsync } from '@datamoc/mwg-retro-audio';
import * as audio from '@datamoc/mwg/audio';
import { renderNotesAsync } from '@datamoc/mwg-retro-audio/mwg';


// music rendered by the package's own voices: the same samples as composeCue, off the main thread
const cue = await composeCueAsync({ style: 'dos-opl2-1987', seed: 7, duration: 30 }, { onProgress, signal });

// the same music as notes, voiced by a retro engine of MWG's worker host, then folded into a seamless loop
const score = await composeNotesAsync({ style: 'dos-opl2-1987', seed: 7, duration: 30 });
const rendered = await renderNotesAsync(audio, score.events, { synth: 'retro:mt32' });
const loop = foldLoop(rendered, score.seconds); // exactly score.seconds long; audio.toAudioBuffer(context, loop)

// a music file (YM, VGM, NSF, MOD...) rendered in a worker
const song = await renderFileAsync(bytes, { load: { name: 'tune.vgm' }, maxSeconds: 120, onProgress, signal });
```

Each call starts one module worker (`compose.worker.js`, `render.worker.js`, next to the module that starts it, which
bundlers find) and terminates it at the end or on `signal`. Without `Worker` (Node) the same code runs in the
calling thread, after a frame; there `signal` takes effect at the next progress report. Pass
`worker: () => ...` to supply your own worker, or `worker: false` to stay on the calling thread. A Node host can wrap
`worker_threads` around the handlers of `@datamoc/mwg-retro-audio/jobs/handlers`.

`composeNotes` leaves the drums to channel 10 and the melodic parts to channels 1 to 3, with a General MIDI program
per part (`programs` overrides them). The voice line (speech or singing) is not music in the MIDI sense: render it with
`composeCue`. `renderFileAsync` takes a file, not a player, because a player is a live object that cannot cross to a
worker; options must be plain data (`chipFactory` is refused). `renderPlayerAsync` stays for a player you built yourself:
it yields to the browser every 30 ms but runs on the calling thread.

## Apply settings once at the right layer

Use `retroLoadFor(settings)` for the fallback PSID region, and `retroSfxEngineOptionsFor` for PAL/NTSC effect ticks.
Keep the clock a file declares. `retroOutputFor(settings, sampleRate)` supplies offline/retro-driver output
processing; `retroBusLoader` accepts it as `output`. The stream loader exposes raw player output and does not apply
that stage. MWG owns bus dynamics and mixing; avoid applying the same filter or limiter at both layers.

Run `npm run check`, `npm test`, `npm run build`, `npm run format:check` and `npm run check:bundles` after changing
the integration. Worker core parity is covered by `tests/worker-cores.test.ts`.

With a sibling MWG checkout, check the real worker host after building this package:

```sh
node ../mwg/tools/check-retro-cores.mjs --package . --engines retro:d50,retro:mt32,retro:dx7,retro:m1 --seconds 1
```

Use native Node with TypeScript stripping (or built JavaScript) for this probe. Running MWG's source through `tsx`
can inject helpers into functions that the host serializes, causing the worker to fail and fall back to inline
execution. The four engines above were checked with MWG 0.52.0: worker mode, no underruns, matching direct output.

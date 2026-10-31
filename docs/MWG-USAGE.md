# Using retro audio with MWG

This integration targets `@datamoc/mwg` **0.49.x** (`^0.49.0`), the published version checked on 31 October 2026.
Install both packages in a consuming application:

```sh
npm install @datamoc/mwg@^0.49.0 @datamoc/mwg-retro-audio
```

Development keeps `file:../mwg`; the sibling checkout and its built `dist` must be current. MWG remains an optional
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

For standard MIDI with a SoundFont, MWG 0.49.0's `renderMidiToBufferAsync` accepts `decode` for compressed embedded
SoundFont 3 samples. Prefer that native route when retro chip emulation is not needed.

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
execution. The four engines above were checked with MWG 0.49.0: worker mode, no underruns, matching direct output.

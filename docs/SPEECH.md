# Native speech

For spoken dialogue, use the browser's speech engine instead of the small retro
formant synthesizer. Voice quality and availability depend on the browser and OS.
No model download or additional package is required.

```ts
import { BrowserSpeech } from '@datamoc/mwg-retro-audio';

if (BrowserSpeech.supported) {
    const speech = new BrowserSpeech();
    await speech.ready(); // voices can load asynchronously
    console.table(speech.voices()); // name, voiceURI, lang, localService
    // Run speak from a click/key handler; browsers can block unsolicited speech.
    await speech.speak('Bienvenue au village.', {
        language: 'fr-FR', rate: 1, pitch: 1, localOnly: true,
    });
    speech.dispose();
}
```

Pass `voice` with a name or URI to select a particular voice. Without it, the
service prefers an exact language match, then the same base language. With
`localOnly: true`, it rejects if no matching installed voice is available.
Otherwise, browser voices may use a remote service. `ready()` waits up to 1.5 s;
an empty list after that can still mean the browser has a default voice.

`speak()` queues lines and resolves when playback finishes. `cancel()` rejects
unfinished lines. Browser speech shares one queue per page: cancellation also
stops speech queued by other components. Do not create a service per line.

Native browser speech plays directly to the output device. It does not return
PCM, enter an AudioContext, export WAV, feed a vocoder, or sing timed notes.
Its pitch control is relative (1 = normal), unlike the formant API's Hz value.
`SpeechService`, `singLyrics` and the synchronous formant APIs remain available
for retro effects, singing and deterministic sample rendering.

## Windows rendering in Node

Windows SAPI can return samples for offline rendering and vocoder input. The
separate Node entry keeps child processes out of browser bundles.

```ts
import { synthesizeWindowsSpeech } from '@datamoc/mwg-retro-audio/node/speech';

const result = await synthesizeWindowsSpeech('Bonjour, préparez-vous !', {
    language: 'fr-FR', // or en-US; requires an installed matching voice
    // voice: 'Microsoft Hortense Desktop', // optional exact SAPI voice name
    rate: 0, // SAPI scale -10..10
});
// result.samples: mono Float32Array; result.sampleRate: voice's actual rate
// Pass to SpeechService.toAudioBuffer(), encodeWav(), or vocode().
```

The adapter uses Windows PowerShell and System.Speech, speaks plain text, and
passes input as JSON rather than shell commands. Accented text is preserved.
SAPI exposes installed desktop voices; browser voice lists may differ. It does
not provide neural-quality guarantees or melody-aligned singing.

`composeCue({ ..., sampleRate: result.sampleRate, voiceSamples: result.samples })`
uses this voice for spoken lines, including the disco vocoder. Supply samples at
the cue's sample rate; `voice: 'none'` still disables the line. The same hook can
accept recorded speech or PCM from a neural model.

Run `npx tsx tools/render-native-voice.ts` on Windows for French and English WAV
comparisons and vocoder examples in `demo-output/native-voice/`.

## Optional neural voice pack: Kokoro

Install the runtime only in applications that want neural speech:

```sh
npm install kokoro-js@^1.2.1 @huggingface/transformers@^3.8.1
```

```ts
import { KokoroSpeech } from '@datamoc/mwg-retro-audio/speech/kokoro';

const speech = new KokoroSpeech({
    onProgress: (event) => console.log(event),
});
await speech.ready(); // first use downloads the model; subsequent uses reuse the runtime's cache
console.table(await speech.voices());
const result = await speech.speak('Welcome to the village.', { voice: 'af_heart' });
// Mono 24 kHz PCM, usable with toAudioBuffer(), encodeWav(), vocode(), or composeCue().
await speech.dispose();
```

This adapter is a separate entry point. Importing the main library does not load
Kokoro, Transformers.js or its model. The default quantized weights are about
92 MB, plus runtime and selected voice data. Inference is local after downloading.
Transformers.js caches model downloads on disk in Node and in browser storage
where available; browser storage may be evicted. Applications can configure
Transformers.js `env.cacheDir` / cache settings before loading Kokoro. Repeated
lines use a bounded memory cache (32 by default); returned sample arrays are
independent copies so a mixer cannot corrupt cached dialogue.

`af_heart`, `af_bella` and `am_michael` are US voices; `bf_emma` and `bm_george`
are British. Omitting `voice` selects Heart for `en-US` and Emma for `en-GB`.
A voice's locale must match an explicitly supplied language. French uses Siwis
(`ff_siwis`), through an additional French pronunciation adapter described below.
The upstream kokoro-js wrapper and its npm phonemizer remain English-only; this
library supplies the French model inputs separately.

Browsers default to WASM; Node defaults to CPU. For WebGPU, pass
`{ device: 'webgpu' }` (defaults to fp32, about 326 MB). Run browser inference in a
module worker to keep the game responsive; the adapter itself does not start a
worker. `rate` is 0.5..2, and this backend does not support melody-aligned singing.
Inference is serialized per service. `dispose()` waits for active inference and
rejects unfinished work; it cannot interrupt a native inference call.

The adapter explicitly closes Kokoro's text splitter to avoid the 1.2.1
string-stream hang. Long text is additionally split at word boundaries into
segments of at most 200 characters; a longer single word is rejected. Extreme
phonetic expansion can still hit the upstream model's token limit.

## French neural speech: Siwis

Kokoro's French voice profile is **522,240 bytes** and reuses the same 82M model.
It is downloaded only for the first French line, checked against a SHA-256 hash,
and retained for that service's lifetime. Browser HTTP caching may retain it
between sessions; Node does not persist this profile automatically. For offline
or self-hosted use, read the raw float32 profile yourself and pass
`frenchVoiceData: new Float32Array(arrayBuffer)` to the constructor. The pinned
source is [ff_siwis.bin](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/blob/4685882/voices/ff_siwis.bin).

The pronunciation helper runs eSpeak in a **separate Python process**. This
keeps its GPL runtime outside the TypeScript package. Python needs the two free
packages `phonemizer` and `espeakng-loader`; the latter supplies the native
eSpeak library and French language data. For an isolated local setup:

```sh
python -m venv download/french-tts-runtime
# Windows:
download/french-tts-runtime/Scripts/python.exe -m pip install phonemizer==3.4.0 espeakng-loader==0.2.4
# Linux/macOS: use download/french-tts-runtime/bin/python instead.
```

```ts
import { KokoroSpeech } from '@datamoc/mwg-retro-audio/speech/kokoro';
import { createFrenchPhonemizer } from '@datamoc/mwg-retro-audio/node/french-phonemizer';

const speech = new KokoroSpeech({
    frenchPhonemize: createFrenchPhonemizer({
        python: 'download/french-tts-runtime/Scripts/python.exe',
    }),
});
const result = await speech.speak('Bienvenue au village. Le gardien approche !', {
    language: 'fr-FR', // selects ff_siwis; voice: 'ff_siwis' also infers French
});
// result is mono 24 kHz PCM, also suitable for the vocoder.
await speech.dispose();
```

French nasal vowels, accents, punctuation and number pronunciation come from
the French eSpeak data. The IPA is mapped using Misaki's Kokoro v1.0 convention;
French r and nasal marks are preserved. Overlong phoneme sequences reject
rather than being silently truncated. Names and unusual words may still need
pronunciation corrections. Siwis is currently the only supplied French neural
voice; it is not a voice-cloning system or a singing model.

This Node helper works locally without a server. For browser French, provide
your own `frenchPhonemize(text): Promise<string>` that returns stressed French
eSpeak-compatible IPA with `^` ties. A browser French phonemizer is not bundled
or validated here. A missing French phonemizer is rejected before a model
download. A configured French voice appears in `await speech.voices()`.

Render the three French examples and one vocoder cue with:

```sh
npx tsx tools/render-french-neural-voice.ts download/french-tts-runtime/Scripts/python.exe
```

Files appear in `demo-output/neural-voice/ff_siwis*.wav`; timings and exact text
are recorded in `french-results.json`. English and French can share one service
and one loaded model. Siwis weights are covered by the Kokoro Apache-2.0 model
license; upstream credits the [SIWIS dataset (CC BY 4.0)](https://datashare.ed.ac.uk/handle/10283/2353).

The model weights and kokoro-js are Apache-2.0. They are downloaded separately,
not redistributed inside this package; preserve their license and attribution
files when self-hosting them. The runtime also brings its own third-party
dependencies and notices. The current optional runtime dependency tree reports
npm audit advisories (including the unused image-processing dependency sharp);
review upstream updates for your application's deployment.

## Comparing neural voices

`npx tsx tools/render-neural-voice.ts` renders five Kokoro voices and their
vocoder versions to `demo-output/neural-voice/`. `results.json` records generation
times. On this Windows CPU, the cached q8 model loaded in about 1.2 s and these
short lines rendered at roughly real time (4.2–5.1 s for 4.3–5.2 s of speech).
The initial uncached model load took about 7.3 s. These are local measurements,
not performance guarantees; browser performance has not been measured.

For a smaller alternative, `python tools/render-kitten-voice.py` renders Bella
and Jasper from **Kitten Nano 0.8 int8** (Apache-2.0, about 25 MB), using the same
English line. It requires `numpy`, `onnxruntime`, `soundfile` and the optional
npm runtime's phonemizer. Downloaded model files go to `download/voices/`.
The comparison renderer uses the released 0.8 vocabulary and inference recipe;
it is not a full Kitten text normalization implementation. These two lines
rendered in about 0.57 s and 0.33 s here. Kitten is supplied as a comparison tool,
not yet a browser backend. Neither candidate has been judged by ear here.

Sources: [Kokoro.js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js),
[Kokoro weights and license](https://huggingface.co/hexgrad/Kokoro-82M),
[Kitten Nano int8](https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8),
[SpeechSynthesis API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis).

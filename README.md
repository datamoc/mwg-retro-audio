# @datamoc/mwg-retro-audio

**[Démo interactive en ligne](https://datamoc.github.io/mwg-retro-audio/)** — 46 synthétiseurs et puces sonores, lecture automatique de morceaux MIDI, en français, anglais et allemand (page autonome : [`examples/piano/synth-demo.html`](examples/piano/README.md)). Licence MPL-2.0.

Évolutions et suivi : [roadmap](ROADMAP.md). La [compatibilité optionnelle avec
Tone.js](docs/TONEJS.md) dispose d'un [exemple exécutable](examples/tonejs/README.md).

La [synthèse simple](docs/SIMPLE-SYNTH.md) propose neuf profils d'instruments,
des accords et une API de notes avec vélocité et sustain.
Les [imports ciblés et mesures de bundles](docs/BUNDLES.md) permettent de choisir
un profil ou une puce sans embarquer tout le catalogue.
Le [piano interactif](examples/piano/README.md) joue tous les modèles du catalogue —
profils simples, PSG, puces à registres et synthétiseurs historiques — à la souris,
au clavier de l'ordinateur ou avec un clavier MIDI via Web MIDI.

Module audio rétro de la famille **mwg** (`@datamoc/mwg`), à double vocation :

1. **Synthetiseurs et puces historiques pour les jeux mwg** - `src/chips/` : YM2149/AY, SID, NES APU et ses expansions, SN76489/Tandy, YM2612, YM2151, OPN, OPL2/OPL3, SAA1099, PC speaker, cartes C/MS et Sound Blaster, Apple II/Mockingboard, Yamaha DX7 et synthés historiques modélisés (`src/chips/historical.ts`), backend YM2149 bit-exact d'Hatari en GPL séparé (`vendor/hatari-ym/`).
2. **Lecteur universel de musiques électroniques pré-MP3** — `loadFile()` (`src/formats/`, `src/players/`) : YM, VGM/VGZ, NSF/NSFE, PSID/RSID, SPC, MIDI/XMI, MOD/XM/S3M/IT, DRO, IMF, CMF, HSC, RAD, ROL, D00, SCI, WAV, VOC et le format universel MWA. Voir [`docs/ORGANISATION.md`](docs/ORGANISATION.md) pour la carte complète.
A retro multi-chip audio engine in **pure TypeScript** on the **native Web Audio API**: no WebAssembly, no worklet,
no dependency. It plays the music and rebuilds the sound effects of the machines of the 1980s and early 1990s from
the registers their software wrote, the way the hardware did.

It is written to the specification `sp_cifications_techniques_globales_moteur_audio_r_tro_multi_puces_typescript.md`
(sections 1-8); [`CONFORMANCE.md`](CONFORMANCE.md) states, item by item, what is implemented, how faithfully, and what
is not.

```ts
import { loadFile, RetroStream } from '@datamoc/mwg-retro-audio';

const ctx = new AudioContext();
const bytes = new Uint8Array(await (await fetch('music/airball.ym')).arrayBuffer());
const player = loadFile(bytes, { sampleRate: ctx.sampleRate, loop: true }); // YM, VGM, NSF, SID, MOD, XM, IT, DRO, IMF, CMF, WAV, VOC, MWA
new RetroStream(ctx, ctx.destination, player).start();
```

## Three layers

| Layer               | Where                | What                                                                                                                                                                                                                   |
| ------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Parser / player  | `formats`, `players` | files -> timed register writes: YM (YM2!-YM6! with SID voice, digidrums, sync-buzzer), VGM / VGZ, NSF / NSFE and PSID / RSID (a real cycle-counted 6502), MOD / XM / IT (tracker engine), DRO, IMF, CMF, VOC, WAV, MWA |
| 2. Chip emulation   | `chips`              | YM2149 / AY-3-8910, SN76489 (+ Tandy), NES 2A03 APU, MOS 6581 / 8580 SID, YM2612, YM2151, YM3812 (OPL2) / YMF262 (OPL3), SAA1099, PC speaker, sample DAC; cards: C/MS / Game Blaster, Sound Blaster family             |
| 3. Web Audio output | `driver`             | `AudioDriver`, `PSGVoice`, `RetroStream` (gapless scheduling), `OutputStage` (anti-aliasing, DAC non-linearity, profiles of the original analogue paths), `renderPlayer` / `encodeWav` offline                         |

**PAL / NTSC.** The standard of the original file decides the frame rate _and_ the chip clocks (`Clocks`,
`FrameRates`): a PAL tune plays 2.3 cents off from its NTSC version, the Amiga module follows the 7.09 / 7.16 MHz Paula
clock, an NSF follows 1.66 / 1.79 MHz. Nothing assumes a standard.

## Sound effects

Effects are data (`SfxDefinition`): curves of pitch, volume, noise, mix, duty and raw register writes per tick,
evaluated at the original frame rate. `SfxEngine` plays them **on the same chip as the music**: it lends a channel to
the effect (priority, retrigger policy), keeps the music's register state and gives the channel back. Digitised
voices are played through volume registers (the 4 bit digi technique). `renderSfx` produces an effect offline.

```ts
const engine = new SfxEngine({ region: Region.PAL });
engine.define({
	name: 'laser',
	chip: 'ym2149',
	priority: 5,
	retrigger: 'restart',
	length: 30,
	voices: [{ channel: 'any', pitch: { start: 96, step: -1.5, min: 40 }, volume: { start: 15, step: -0.4, min: 0 } }],
});
const player = loadFile(bytes, { sampleRate, chipFactory: engine.wrapFactory() });
engine.play('laser');
```

## The universal format: MWA

Every register driven format converts to **MWA**, a compact DEFLATE-compressed log of timed register writes with the
chips and their clocks inside; decoding needs nothing but this package (`docs/MWA.md`).
`convertToMwa(bytes)` does it for YM, VGM, NSF and PSID tunes; DRO, IMF and CMF compile to the same data.

## With mwg (`@datamoc/mwg`)

`@datamoc/mwg-retro-audio/mwg`: `retroPlayableFactory` (a `Playable` for `Music`'s crossfades), `retroBusLoader` and
`renderTrack` (a `LoadedTrack` with the loop region for `Channel` / `AudioBus`). Against mwg 0.44's retro-audio
contracts it adds: `retroBlockSource` / `retroLoopRegion` (a `BlockSource` for `StreamChannel` / `StreamPlayable`,
endless tunes streamed instead of rendered), `registerRetroMidiEngines(registerMidiSynth)` (`retro:mt32`,
`retro:dx7` with SysEx bank dumps, `retro:d50`), `retroSfxBackend` (our `SfxEngine` as one of mwg's `SfxBackend`s,
with `toMwgSfxDefinition` boarding our definitions through mwg's `SfxBank`), and `retroLoadFor` / `retroOutputFor`
(mwg's player-facing `AudioSettings` mapped onto load options and the hardware output stage). `docs/MWG-REQUIREMENTS.md`
tracks what each side owns; `docs/MWL-PROPOSAL.md` proposes the MWL evolution that lets a character, its animations,
scripts, effects and music travel as one file.

## Exporting a render

```ts
import { renderPlayer, exportAudio, exportAudioBlob } from '@datamoc/mwg-retro-audio';

const result = renderPlayer(loadFile(bytes, { sampleRate: 44100 }), { maxSeconds: 120 });
const flac = await exportAudio(result, 'flac', { bitsPerSample: 24, tags: { title: 'Airball' } }); // Uint8Array
const opus = await exportAudioBlob(result, 'opus', { opus: { bitrate: 96_000 } }); // Blob, needs WebCodecs
```

WAV and FLAC are written by the package in any environment. Opus uses WebCodecs `AudioEncoder` (current Chrome, Edge,
Safari, Firefox) or the `encoder` option; `isOpusEncodingAvailable()` tells which. Saving the file is up to the caller.

## Licensing, ROMs and the Hatari backend

- This package is **MPL-2.0**, like mwg. It contains **no ROM and no code of a GPL emulator**.
- The Atari ST chain of Hatari (bit-exact, GPL-2.0-or-later) is a separate package, `hatari-ym`; an application that
  wants it registers it: `registerHatariYm(registerChip)` (`hatari-ym/chip`).
- Roland D-50 / MT-32 (LA synthesis, `D50Synth` and `Mt32Synth`) and Korg M1 (AI synthesis, `M1Synth`) are modelled
  **without their sample ROMs**, in the browser: waves are generated from parametric recipes, tuned offline against the real instruments. No ROM, no sample
  derived from a ROM and no native program is part of the package. The MT-32 SysEx handling (checksums, memory map,
  LCD) is built in (`Mt32Session`). D-50 patch SysEx files are read by `parseD50SysEx` into patches for `D50Synth`.

## Development

```sh
npm install
npm run check   # tsc --noEmit
npm test        # node --import tsx --test (the whole suite, a few seconds)
npm run build   # dist/ (ES modules + declarations)
```

Tests use real tool output where it exists (LHA archives made by LHarc / LHA, the Klaus Dormann 6502 functional test
was used to validate the CPU) and synthetic files built from the format specifications otherwise; no recording of
real hardware is part of the repository.

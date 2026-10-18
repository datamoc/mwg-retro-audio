# Organisation de mwg-retro-audio

Paquet `@datamoc/mwg-retro-audio` (anciennement `mw-retro-audio`, développé dans
`airball/mw-retro-audio`), module audio rétro autonome de la famille **mwg**
(`@datamoc/mw_games`, dépendance pair optionnelle, liée en développement par
`file:../mwg`). Deux vocations, un seul moteur : les fichiers sont transformés en
écritures de registres datées, les puces les rendent en échantillons, le pilote
Web Audio les fait entendre.

## 1. Synthétiseurs et puces historiques — pour les jeux mwg

| Dossier / fichier | Contenu |
| --- | --- |
| `src/chips/` | Émulations registre par registre : YM2149/AY-3-8910, SN76489 (+ Tandy), NES 2A03 APU, MOS 6581/8580 SID, YM2612, YM2151, OPN (YM2203/YM2608), OPL2/OPL3, SAA1099, PC speaker, DAC PCM, Apple II et Mockingboard, expansions NES (VRC6, Sunsoft 5B, MMC5, Namco 163, FDS), cartes C/MS Game Blaster et Sound Blaster |
| `src/chips/Dx7.ts` + `src/formats/dx7.ts` | Yamaha DX7 (FM 6 opérateurs, banques SysEx) |
| `src/chips/historical.ts` | Synthés historiques modélisés par architecture : synthèse additive, Casio VL-1, Synclavier, Yamaha GS-1, synthèse LA, synthèse AI |
| `src/instruments/` | Instruments jouables par note au-dessus des puces : API simple (`simple.ts`), adaptateurs PSG, synthés modélisés et puces à registres (`RegisterInstrument`), enveloppes et vibrato partagés, allocation de voix, contrôles exposés aux interfaces ; `catalogue.ts` = liste explicite de tous les modèles pour les sélecteurs d'interface (import ciblé : l'application ne charge que ce qu'elle liste) |
| `src/sfx/` | Effets sonores en données (`SfxDefinition`), joués sur la même puce que la musique, import depuis des journaux de registres |
| `src/mwg/` | Adaptateurs mwg : `RetroPlayable` (un `Playable` pour les fondus de `Music`), `retroBusLoader` / `renderTrack` (un `LoadedTrack` bouclé pour `Channel` / `AudioBus`) ; côté contrats 0.44 : `retroBlockSource` / `retroLoopRegion` (`BlockSource` pour `StreamChannel` / `StreamPlayable`), moteurs MIDI nommés `retro:mt32` / `retro:dx7` / `retro:d50` pour `registerMidiSynth` (`instrumentEngines.ts` : `InstrumentMidiSynth` et `instrumentMidiEngines` pour n'importe quel modèle ; `catalogueEngines.ts`, importé à part par `/mwg/catalogue` : les 46 modèles en `retro:<id>`), `retroSfxBackend` (`SfxBackend` pour les banques `SfxBank` de mwg), `retroLoadFor` / `retroOutputFor` (`AudioSettings` du joueur) ; voir `docs/MWG-REQUIREMENTS.md` |
| `vendor/hatari-ym/` | Backend YM2149 bit-exact porté d'Hatari 2.5.0, **GPL-2.0-or-later**, volontairement séparé du cœur MPL-2.0 ; s'enregistre via `registerChip('ym2149', …)` / `hatari-ym/chip` |

## 2. Lecteur universel de musiques électroniques pré-MP3

Point d'entrée unique : `loadFile(bytes, options)` (`src/formats/load.ts`),
détection par contenu (`detectFormat`), rendu hors ligne possible
(`renderPlayer` / `encodeWav`).

| Famille | Formats | Fichiers |
| --- | --- | --- |
| Journaux de registres | YM2!–YM6!, VGM/VGZ, DRO, IMF, MWA (format universel maison, voir `docs/MWA.md`) | `ym.ts`, `vgm.ts`, `opl-logs.ts`, `mwa.ts` |
| Machines à CPU émulé | NSF/NSFE, PSID/RSID (6502 compté en cycles), SPC (SNES) | `nsf.ts`, `psid.ts`, `cpu6502.ts`, `spc.ts` |
| Trackers | MOD, XM, S3M, IT | `tracker/` (`player.ts`, `mixer.ts`, parseurs par format) |
| AdLib et PC | CMF, HSC, RAD, ROL (+ banque `.bnk`), D00, SCI0 (+ `patch.003`) | `cmf.ts`, `hsc.ts`, `rad.ts`, `rol.ts`, `d00.ts`, `sci.ts` |
| MIDI pré-MP3 | SMF, XMI, SysEx Roland et DX7 | `midi.ts`, `roland.ts`, `dx7.ts` |
| Échantillons d'époque | WAV, VOC (Creative) | `pcm.ts` |
| Conteneurs | LHA/LZH (décompression `-lh0-`/`-lh5-`), DEFLATE | `lha.ts`, `inflate.ts` |
| Divers | Apple II, conversion vers MWA (`convertToMwa`) | `apple2.ts`, `mwa.ts` |

## 3. Sortie

`src/driver/` : `AudioDriver`, `RetroStream` (planification sans trou),
`OutputStage` (profils des étages analogiques d'origine), `Renderer` /
`encodeWav` (rendu hors ligne), `Resampler`, `Compare` (mesures pour les tests).
`src/region.ts` fixe horloges et cadences PAL/NTSC d'après le fichier d'origine.

## 4. Arborescence livrée

```text
mwg-retro-audio/
├── package.json          @datamoc/mwg-retro-audio, entrées ., ./chips, ./formats, ./driver, ./sfx, ./mwg, ./instruments et sous-chemins ciblés ./chips/*, ./instruments/*, …
├── README.md  CONFORMANCE.md  ROADMAP.md  LICENSE (MPL-2.0)  NOTICE
├── docs/                 MWA.md, MWL-PROPOSAL.md, ORGANISATION.md (ce fichier), SIMPLE-SYNTH.md, TONEJS.md, BUNDLES.md (+ bundle-results.json)
├── src/                  chips/ formats/ (+ tracker/) driver/ players/ instruments/ sfx/ mwg/ node/ index.ts region.ts
├── examples/             piano/ (clavier interactif), tonejs/ (intégration Tone.js) ; compilés et servis par tools/examples.mjs
├── tests/                suite node:test complète + fixtures/ (archives LHA réelles)
└── vendor/hatari-ym/     paquet GPL séparé : src/ test/ scripts/ tools/ (sans node_modules, dist ni ref/)
```

## 5. Non copié, et pourquoi

Depuis le dossier de développement `airball/` :

- `mw-retro-audio/node_modules/` et `dist/` : régénérables (`npm install`, `npm run build`).
- `hatari-ym-ts/ref/` (~110 Mio de PCM de référence Hatari) : ne sert qu'à
  regénérer les fixtures ; les tests livrés utilisent `vendor/hatari-ym/test/fixtures/`.
- `airball/work/`, `capture/`, `compare/`, `extracted/`, `output/`, `ghidra_*`,
  `hatari-ym-ts` hors paquet : recherche et reverse engineering du jeu Airball
  (désassemblage 68000, calibration), pas des fichiers du module.
- `free-soundfonts/` : dépôt voisin indépendant, aucune dépendance du code.

## 6. Exemples et intégrations optionnelles

- `src/instruments/simple.ts` : neuf profils additifs et API de notes ;
  [guide](SIMPLE-SYNTH.md).
- `src/instruments/catalogue.ts` : catalogue explicite de tous les modèles
  jouables (profils simples, PSG, puces à registres, synthés historiques) ;
  les imports ciblés par module évitent de l'embarquer
  ([guide](BUNDLES.md)).
- `src/driver/tone.ts` : pont vers un contexte et un effet Tone.js sans dépendance
  obligatoire ; [guide](TONEJS.md).
- `examples/tonejs/` : mélodie YM générée et synthé Tone.js dans un même graphe.
- `examples/piano/` : piano interactif pour tous les modèles du catalogue —
  souris, clavier d'ordinateur, Web MIDI (note-on/off, vélocité, sustain),
  panneau adaptatif, reflet des notes actives, coupure d'urgence ;
  [état et commandes](../examples/piano/README.md).
  `tools/examples.mjs piano|tonejs` compile l'exemple et le sert localement.

## 7. Vérification

```sh
npm install     # lie @datamoc/mw_games -> ../mwg
npm run check   # tsc --noEmit
npm test        # node --import tsx --test "tests/**/*.test.ts"
npm run build   # dist/
npm run check:bundles  # applications témoins compilées et mesures [docs/BUNDLES.md]
npm run check:piano    # exemple piano rejoué dans Chrome headless [examples/piano/README.md]
```

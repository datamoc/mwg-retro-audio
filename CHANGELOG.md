# Journal des modifications

Les versions suivent [SemVer](https://semver.org/lang/fr/). Tant que le numéro majeur est 0, une version mineure
peut changer une interface.

## 0.2.0 — à publier avec `@datamoc/mwg` 0.47.0

Le paquet exige maintenant `@datamoc/mwg` ≥ 0.47.0 (pair facultatif) : les cœurs empaquetés s'appuient sur
`factorySource` de l'hôte hors fil principal, apporté par mwg 0.47.0.

### Ajouts

- **Démo piano** (`examples/piano`, publiée sur GitHub Pages) : 48 modèles répartis par machine, lecture automatique de
  morceaux MIDI, enregistrement et export `.mid`, export audio du morceau courant en FLAC, Opus ou WAV, banques
  SoundFont 2 de l'utilisateur, **liens de partage** (modèle, réglages et morceau compressés dans l'URL, un MIDI
  importé tronqué par dichotomie, confirmation avant de jouer), interface en français, anglais et allemand, disposition
  AZERTY, QWERTY ou QWERTZ.
- **Nouveaux modèles** : Roland LAPC-I (même moteur que le MT-32), Korg microKORG (15 programmes), voix SoundFont 2.
- **Sous-chemin `@datamoc/mwg-retro-audio/mwg/worker-cores`** : `retroCoreNames` et `retroCoreSource(name)`, le texte
  autonome de la fabrique de chacun des 48 moteurs MIDI, pour `AudioCoreHost` de mwg (`factorySource`). Un module par
  moteur (`…/worker-cores/retro-d50`) : 7 à 62 Ko chacun. Sortie identique, à l'échantillon près, à celle du moteur
  direct (test).
- **`inspectD50Patch(octets)`** : avertit des patchs D-50 qui demandent les ondes PCM 77-100, jouées avec une onde de
  remplacement, pour `verifyPackage(…, { inspectPatch })` de mwg.
- `renderPlayerAsync`, `writeSmf`, `parseSf2`, `soundFontInstruments`, `trimLeadingSilence`, `./mwg/catalogue`
  (importer un moteur par modèle, hors du chemin `./mwg` pour garder les imports ciblés légers).
- Champ `funding` et `.github/FUNDING.yml`.
- **Option `budget` de `LoadOptions`** (type `InstructionSpender`, un `spend(nombre)` qui lève une fois l'allocation
  épuisée) : les lecteurs NSF, PSID et SPC y comptent les instructions qu'ils émulent, pour qu'un fichier hostile ou
  cassé échoue par son nom au lieu de se rendre plus lentement que le temps réel. Le `InstructionBudget` de mwg a cette
  forme (rien n'est importé de mwg) ; il lève alors une `DecodeBudgetError`. Sans budget, rien ne change.

### Corrections

- **Plafond de sortie des lecteurs d'archives** : `inflateRaw`, `gunzip`, `unzlib` et `unlha` s'arrêtent à
  `DEFAULT_MAX_OUTPUT` (64 Mio, comme `decoderLimits` de mwg) et lèvent une erreur au-delà. La taille qu'annonce le
  fichier (le pied d'un gzip, l'en-tête d'un LHA) n'est plus une raison d'allouer : un gzip qui annonce 4 Gio ou une
  bombe DEFLATE de moins de 20 Ko pour 8 Mio ne dépasse plus le plafond. Le plafond se règle par appel direct
  (`inflateRaw(données, début, taille, plafond)`, `unlha(données, plafond)`), pas depuis `loadFile`.
- **`reset()` ramène désormais un moteur à l'état d'un moteur neuf** : le D-50 (et le MT-32 et le LAPC-I, qui en
  contiennent neuf) oubliait la phase du chorus et l'âge des voix, le VL-1 la phase et le temps de la voix.
- **Konami VRC6** : le canal à impulsions restait en mode « volume constant » (aucun son), la période était plafonnée à
  511 (tout ce qui est sous le la grave était faux) et la dent de scie sonnait une octave trop bas.
- **NES APU (NTSC et PAL) et MMC5** : silence sous 110 Hz environ, à cause du mute du balayage de fréquence.
- **YM2612, YM2203 et YM2608** : le porteur FM sonnait une octave trop bas.
- **Sample DAC (Covox)** : ne produisait qu'un échelon de tension ; il calcule maintenant la forme d'onde de quatre voix.
- **Lecteurs RAD et D00** : durcis contre les fichiers malformés (boucles sans fin, tailles hors bornes).

### Contrôles

- `tests/instrument-audit.test.ts` : chacun des 48 modèles sonne sur trois hauteurs, sans NaN ni écrêtage, et les
  moteurs réparés jouent la bonne note.
- `tests/instruction-budget.test.ts` et `tests/decoder-limits.test.ts` : un NSF, un PSID et un SPC qui ne rendent jamais
  la main sont arrêtés par le budget ; une bombe DEFLATE, un gzip et un LHA qui annoncent des gigaoctets sont refusés.
- `tests/worker-cores.test.ts` : un texte par moteur, sans `import`, `eval`, WebAssembly ni DOM, sortie identique au
  moteur direct, `reset()` identique à un moteur neuf.

## 0.1.0

Première version : puces sonores historiques, formats de fichiers, lecteurs de modules et de musiques de puces,
synthétiseurs sans ROM, rendu hors ligne et sortie Web Audio.

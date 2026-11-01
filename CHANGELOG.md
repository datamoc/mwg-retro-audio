# Journal des modifications

Les versions suivent [SemVer](https://semver.org/lang/fr/). Tant que le numéro majeur est 0, une version mineure
peut changer une interface.

## Non publié

- **Pair de développement mwg `0.53.1`** : 0.53.1 n'ajoute que `Picture.setTone`, sans changement de
  l'API audio utilisée ici ; les tests tournent désormais contre cette version. La plage publique du pair
  reste `^0.53.0`, donc 0.7.0 accepte déjà 0.53.1 chez les consommateurs.

## 0.7.0 - Audio dynamique et mwg 0.53

- **Pair mwg `^0.53.0`** : 0.53 fournit `Channel.insert` / `removeInsert` / `setFilter` et
  `AudioBus.setFilter` ; `retroEffectsFor` insère désormais la chaîne dans la voix sans la redémarrer.
- **Voix rétro jouables** : `retroVoice({ chip, context, destination })` construit sur `PSGVoice`, avec
  `setFrequency` / `setVolume` / `stop` et un séquenceur `playNotes([{ note, at, duration }])` (noms de notes,
  boucle, horloge Audio) ; `retroSequencer` en est la forme abrégée.
- **Effets rétro nommés** : `retroEffects('nes' | 'sid' | 'gameboy' | 'mega-drive' | 'adlib' | 'pc-speaker' |
  'atari-st' | 'bitcrush' | 'lofi' | 'none')` décrit bitcrush, passe-bas de puce, réduction de fréquence et
  non-linéarité de CAC en données validées ; `createRetroEffectChain` les applique en direct et
  `processRetroEffects` hors ligne. `renderSfx(..., { effects })` applique un preset à un bruitage ordinaire.
  `OutputStage` gagne `lowpassQ` pour la résonance de ces presets.
- **Intégration mwg** : `retroEffectsFor(channel, preset)` dans `./mwg` attache la chaîne à un `Channel` par
  `insert` / `removeInsert` (mwg 0.53) ; `retroEffectsLoader(base, preset)` applique un preset aux buffers
  d'un `BusLoader` (SE ordinaires). Un hôte `insertEffect`/`removeEffect` ou une destination inscriptible
  restent les replis pour les versions antérieures.
- **Documentation et écoute** : `CONFORMANCE.md` précise ce que chaque preset change ou non, `README.md` et
  `docs/MWG-USAGE.md` donnent les exemples, et `tools/render-effects.ts` rend un WAV par preset.

## 0.6.1 - Intégration mwg 0.52.1 et niveaux MIDI

- **Pair mwg `^0.52.1`** : testé avec la version publiée, qui fournit `targetPeak` et `targetRms` pour ajuster les niveaux des rendus MIDI.
- **Enregistrement des moteurs sur worker** : une erreur explicite nomme `engines` ou `coreSource` lorsque l'argument est absent et indique l'export correspondant.
- **DX7** : la documentation signale les crêtes possibles au-delà de +/-1, en particulier avec la voix par défaut sans banque SysEx. Un test vérifie la normalisation sur les rendus direct et worker.

## 0.6.0 — mwg 0.52, composition et rendu dans un worker

- **Pair mwg `^0.52.0`** : 0.52 accepte le cœur d'un moteur en texte source et convertit des notes horodatées en
  `MidiFile` sans fichier MIDI intermédiaire.
- **Rendu MIDI asynchrone sur worker** : `registerRetroWorkerMidiEngines` enregistre
  les moteurs `retro:*` avec leur cœur packagé, pour que `renderMidiToBufferAsync` les exécute hors du fil principal ;
  sortie identique au rendu direct, vérifiée pour les 48 moteurs du catalogue.
- **`renderNotesAsync`** : rend des notes horodatées (enregistrement, phrase générée) en échantillons via
  `midiFileFromTimedMessages` et `renderMidiToBufferAsync`, annulable avec un `AbortSignal`.
- **Composition et rendu dans un worker** : `composeCueAsync` (mêmes échantillons que `composeCue`, avec progression et
  annulation), `renderFileAsync` (un fichier YM, VGM, NSF, MOD… rendu hors du fil principal), un worker par appel,
  terminé à la fin ou sur annulation, et repli sur le fil appelant sans `Worker`. `composeCue` est découpé en un plan
  des notes et un rendu, sans changer un seul échantillon (22 cas comparés avant/après).
- **Mode notes** : `composeNotes` / `composeNotesAsync` renvoient la même musique en événements MIDI (basse, accords,
  mélodie, batterie sur le canal 10), `scoreToMidiFile` en fait un fichier, et `foldLoop` replie la queue d'un rendu
  pour boucler sans clic. Les gestionnaires des workers sont exposés par `./jobs/handlers`.

Validation : vérification TypeScript, construction, formatage et mesures de bundles ; 400 tests réussis, un test SCI
facultatif ignoré faute de ressources externes. D-50, MT-32, DX7 et M1 vérifiés sur de vrais Workers de mwg 0.52.0 ;
workers de composition et de rendu vérifiés dans Chrome (échantillons identiques au calcul direct).

## 0.5.0 — optimisation du D-50 et du MT-32

- **Synthèse LA** : suppression des allocations par échantillon, calcul des paramètres fixes une fois par bloc,
  suivi du segment courant des enveloppes et mise en cache des coefficients des filtres inchangés.
- **Chorus et réverbération** : lecture du chorus sans fonction temporaire ni modulos ; bouclage des lignes de
  réverbération par comparaison. Les parties encore silencieuses évitent le traitement des effets tout en
  conservant l'horloge du chorus. Les queues d'effets restent rendues.
- **Attaques des patches SysEx** : partage des échantillons générés entre les voix, avec invalidation lorsqu'une
  recette change ; les notes déjà en cours conservent leurs échantillons.
- **Modulation** : calculs évités lorsque la profondeur est nulle et sélection des tables harmoniques stabilisée.
- **Mesures** : `node --import tsx tools/benchmark-la.ts --quick` compare les presets D-50 et le MT-32 à 16 notes,
  rapporte le temps écoulé et le temps CPU, et produit les empreintes des sorties PCM.

Les sorties PCM avant et après optimisation sont identiques sur les scénarios comparés : huit presets, parties
MT-32, modulation et ondes bouclées. La compatibilité avec le pair facultatif `@datamoc/mwg` reste `^0.49.0`.
Validation : 385 tests réussis, un test facultatif ignoré ; vérification TypeScript, compilation et formatage validés.

## 0.4.1 — métadonnées du dépôt

- `package.json` déclare `repository`, `homepage` et `bugs`, requis par npm pour vérifier la provenance de la
  publication. Aucun changement de code. La 0.4.0 n'a jamais été publiée sur npm.

## 0.4.0 — mwg 0.49, streaming et voix

- **Intégration mwg 0.49.x** : le pair facultatif passe à `^0.49.0`, compatible avec la version publiée de mwg.
  `retroStreamLoader` alimente les BGM/BGS d'`AudioBus` sans rendre un tampon complet, avec les points de boucle
  du fichier et un lecteur indépendant par requête. Les deux chargeurs rétro transmettent l'annulation au
  chargement des octets et rapportent leur progression ; un chargement remplacé est abandonné avant le rendu.
- **Guide `docs/MWG-USAGE.md`** : choix entre streaming et tampons, ressources embarquées, imports ciblés,
  cœurs MIDI sur Worker et réglages de sortie.
- **Voix et chant** : synthèse à formants, phonémisation française et anglaise, chant syllabique, vocodeur,
  `SpeechChip` et `SpeechService`. `BrowserSpeech` utilise les voix du navigateur ; les entrées séparées
  `./node/speech`, `./node/french-phonemizer` et `./speech/kokoro` proposent les rendus Windows et les moteurs
  optionnels. Aucun poids de modèle n'est embarqué ; voir `docs/SPEECH.md` et `NOTICE`.
- **Composition et analyse** : `composeCue`, styles et scènes, `DrumMachine`, estimation du tempo, profils de
  hauteur et comparaison spectrale des rendus.
- Le journal des modifications est désormais inclus dans le paquet npm.

Validation : vérification TypeScript, construction, formatage et mesures de bundles ; 380 tests réussis,
un test SCI facultatif ignoré faute de ressources externes. D-50, MT-32, DX7 et M1 vérifiés sur de vrais Workers
de mwg 0.49.0 : sortie identique au rendu direct, sans sous-alimentation.

## 0.3.0 — ajout de `playTone`

- **`playTone`** (`@datamoc/mwg-retro-audio/sfx`) : joue une fréquence avec forme d’onde, durée, volume et
  transposition en demi-tons optionnelle via Web Audio.

---

## 0.2.0 — `@datamoc/mwg` 0.47.0

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

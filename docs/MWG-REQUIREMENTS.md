# Ce que le framework mwg devrait implémenter pour tirer parti de mwg-retro-audio

Statut (**17 octobre 2026**) : **la majeure partie de ce cadrage a été implémentée par mwg 0.44.0 à 0.44.2** —
registre nommé de moteurs MIDI (`registerMidiSynth`, `resolveMidiSynth`, `onMidiSynthFallback`,
`renderMidiThroughSynth`), contrat de flux continu (`StreamPlayable`, `StreamChannel`, `BlockSource`), budgets de
décodage nommés (`decoderLimits`, `DecodeBudgetError`, `InstructionBudget`, `inflateBounded`), budget mémoire des
bus (`TrackCache`, `createBudgetedLoader`), effets sonores en données (`SfxBank`, `SfxBackend`, `SfxArbiter`, graine
déterministe), paramètres joueur (`AudioSettings` : région, étage de sortie, dynamique, adoucissement), paquets
`.mwp` avec politique de capacités (`requires.retroAudio`, refus des ROM), outil `mwg-audio`, Web MIDI en direct
(`connectWebMidi`), banques `.syx` DX7 nommées et échantillonnées (`SyxBank`), doubles de test
(`FakeRetroPlayer`, `FakeAudioContext`, `FakeBlockSource`) et protocole d'écoute (`docs/listening-protocol.md`).
Deux versions ont suivi : **0.45.0 a renommé le paquet en `@datamoc/mwg`** (`@datamoc/mw_games` devient
un paquet de renvoi ; les imports et le pair ici suivent le nouveau nom) et **0.46.0 lit et écrit les
SoundFont 3** (échantillons Vorbis, Opus ou FLAC — `loadSoundFont`, `webAudioSampleDecoder`, outil
`mwg-soundfonts convert`) : les banques SF3 s'ouvrent donc côté mwg, ce paquet restant SoundFont 2 par
conception.
Ce document reste donc la référence de cadrage ; les sections encore ouvertes sont signalées ci-dessous.

Côté paquet, les adaptateurs qui consomment ces contrats vivent dans `src/mwg/` (sous-chemin `@datamoc/mwg-retro-audio/mwg`) :

| Section de ce document | Côté mwg (0.44) | Côté `mwg-retro-audio` |
| --- | --- | --- |
| 1.1 moteurs MIDI nommés | `registerMidiSynth` / `resolveMidiSynth` / `renderMidiThroughSynth` | `retroMidiEngines`, `registerRetroMidiEngines(registerMidiSynth)` : `retro:mt32`, `retro:dx7` (banques SysEx incluses), `retro:d50` ; les 48 modèles du catalogue (`retro:<id>`, `retro:ym2149`, `retro:sid`…) par `@datamoc/mwg-retro-audio/mwg/catalogue` (`registerRetroCatalogueMidiEngines`), ou un choix de modèles par `instrumentMidiEngines(définitions)` |
| 1.3 contrat de flux continu | `StreamPlayable`, `StreamChannel`, `BlockSource` | `retroBlockSource(player)` et `retroLoopRegion(player)` |
| 1.4 budgets de décodage | `decoderLimits`, `assertInputSize`, `createBudgetedLoader` | utilisables tels quels autour de `loadFile` / `retroBusLoader` ; **encore ouvert** : crochets de budget d'instructions dans les émulateurs 6502 (NSF/PSID) et SPC, que nos chargeurs n'exposent pas encore |
| 1.6 effets en données | `SfxBank`, `SfxBackend`, arbitre | `retroSfxBackend({ engine })`, `toMwgSfxDefinition`, `SfxEngine.isActive(id)` |
| 1.8 étage de sortie et réglages | `AudioSettings` (`region`, `outputStage`, `soften`, `dynamics`) | `retroLoadFor`, `retroOutputFor`, `retroSfxEngineOptionsFor` |
| 7. doubles de test | `FakeRetroPlayer`, `FakeAudioContext`, `FakeBlockSource` | `tests/mwg.test.ts` joue l'interopérabilité réelle contre ces doubles |

Les constats sur mwg venaient de la lecture de `mwg/src/audio` à l'écriture (API d'alors : `Playable`,
`Sound`, `Music`, `Orchestrator`, `Channel` / `AudioBus` avec `BusLoader`, `renderMidiToBuffer` avec `SoundFont`,
`AudioListener` / `SoundSource`, `onCaption`). Ceux sur le paquet viennent de son code et de `CONFORMANCE.md`.

## 0. Principe de partage des rôles

| Reste dans `mwg-retro-audio` | À faire dans mwg |
| --- | --- |
| Formats, puces, synthés sans ROM, rendu, effets sonores en données | Contrats d'intégration, cycle de vie, budgets, sécurité, paquets, outils, interface joueur |
| Aucune ROM, aucun échantillon issu d'une ROM (règle écrite dans `CONFORMANCE.md`) | Faire respecter cette règle dans la chaîne de contenu (section 6) |
| Fonctionne dans un navigateur, sans WebAssembly ni worklet | Offrir, **en option**, l'hébergement hors fil principal (section 1.2) |

Priorités : **P0** bloquant pour qu'un jeu utilise le paquet proprement, **P1** forte valeur, **P2** confort,
**P3** à décider plus tard.

## 1. Moteur audio

### 1.1 Un point d'insertion pour les synthétiseurs MIDI (P0)

Aujourd'hui `renderMidiToBuffer(…)` ne sait voiser qu'avec une `SoundFont` ou le synthé intégré
(`RenderMidiOptions.soundfont`). Les synthés du paquet (`Mt32Synth`, `D50Synth`, `M1Synth`, `Dx7Synth`, OPL) ne
peuvent donc pas servir de « banque de sons » d'un morceau MIDI.

À implémenter :

- une interface `MidiSynth` minimale : `event(status, data1, data2)`, `sysex(bytes)`, `render(left, right, start, count)`,
  `reset()`, `sampleRate` (le `Chip` du paquet la satisfait déjà ; `Mt32Synth` est aussi un `LaRomProvider` de
  `Mt32Session`) ;
- `RenderMidiOptions.synth?: (sampleRate) => MidiSynth`, prioritaire sur `soundfont` ;
- le même point d'insertion pour `MidiPlayer` (lecture directe) ;
- un registre de moteurs nommés (`'gm-soundfont'`, `'retro:mt32'`, `'retro:d50'`, `'retro:opl2'`…) pour qu'un fichier
  de contenu écrive `synth: "retro:mt32"` ;
- la **chaîne de repli** : synthé demandé → autre synthé → SoundFont → synthé intégré, avec un événement de
  diagnostic quand on retombe.

Critères d'acceptation : un SMF de test joue la même note à la même hauteur par chacun des moteurs ; le choix d'un
moteur inconnu ne casse pas le jeu (silence ou repli, jamais d'exception non rattrapée).

### 1.2 Hébergement hors fil principal (P1)

Le paquet synthétise sur le fil principal (choix de la spécification : ni worklet ni WebAssembly). Mesures de
développement : 16 voix tenues de `M1Synth` ≈ 1,4× le temps réel, `D50Synth` ≈ 1,1× ; c'est trop près de la limite
pour un jeu qui dessine aussi.

À implémenter :

- un hôte générique `AudioCoreHost` qui exécute un cœur de synthèse (un `RetroPlayer` ou un `MidiSynth`) dans un
  **Worker** (ou un `AudioWorklet` quand le contexte l'autorise), en lui envoyant les événements datés et en
  recevant des blocs de sortie, avec repli transparent sur le fil principal ;
- un tampon circulaire partagé (`SharedArrayBuffer` quand l'isolation inter-origines est active, copies sinon) ;
- la même interface `Playable` en façade, pour que `Music`, `Orchestrator` et `AudioBus` ne voient pas la
  différence ;
- une **mesure de sous-alimentation** (underrun) remontée à la télémétrie bornée existante (item 378) et à un
  événement `audio:underrun`.

Critères : une partie de 10 minutes avec 16 voix de synthé sans trou audible sur la machine de référence ; le
repli sur le fil principal fonctionne quand `Worker` est indisponible.

### 1.3 Contrat de flux continu pour `Playable` (P0)

`Playable` calque `HTMLAudioElement`. `RetroPlayable` du paquet l'implémente, mais plusieurs choses restent
implicites. À documenter et tester dans le cœur de mwg :

- `currentTime` sur un flux synthétisé : lecture et déplacement (le paquet saute des trames pour déplacer) ;
- `playbackRate` : le paquet ne le prend pas en charge sur un flux ; décider si mwg rééchantillonne ou refuse ;
- `onended` pour les morceaux qui bouclent ou qui ne finissent jamais (NSF, SID) ;
- la **fréquence d'échantillonnage** : le lecteur doit avoir celle du `AudioContext` ; mwg doit soit créer le
  contexte à la fréquence voulue, soit rééchantillonner à l'entrée, plutôt que laisser l'appelant s'en occuper.

### 1.4 Budget mémoire et durée des rendus (P0)

`retroBusLoader` rend un morceau en entier dans un `AudioBuffer`. Cinq minutes en stéréo à 44,1 kHz = environ 100 Mo,
et un NSF ou un SID n'ont pas de fin.

À implémenter :

- une **politique de budget** du bus : durée maximale (`maxSeconds`), mono / demi-fréquence pour les ambiances,
  éviction LRU des buffers rendus, plafond total en Mo ;
- un mode **flux** (pas de pré-rendu) pour les longs morceaux, avec bouclage sur la région du fichier ;
- le rendu en arrière-plan avec progression (`BusLoader` aujourd'hui rend une promesse sans progression) et
  annulation ;
- un fondu de sortie configurable pour les morceaux sans fin (le paquet en applique un de 2 s).

### 1.5 Musique adaptative et pistes séparées (P1)

Les puces exposent `setMuted(canal)` ; les journaux de registres et les trackers ont des canaux nommés.

À implémenter :

- dans `Music` / `Orchestrator` : couper ou ré-activer des **canaux** (ou des groupes) d'un morceau en cours, avec
  fondu, pour de l'intensité adaptative sans changer de fichier ;
- le **déplacement synchronisé** entre deux versions d'un morceau (position en trames, pas en secondes) ;
- la région de boucle issue du fichier (`loopStartSeconds`) comme source par défaut de `LoopRegion`.

### 1.6 Effets sonores en données (`SfxDefinition`) (P1)

Le paquet joue un effet **sur la même puce que la musique** : il prête un canal, applique une priorité et une
politique de redéclenchement, puis rend le canal. Ce modèle n'existe pas dans mwg (où `Sound` lit un fichier).

À implémenter :

- un type `Sound` (ou `SfxSound`) qui accepte une `SfxDefinition` ou l'id d'un `sound_effect` de contenu ;
- le **partage de priorité** entre l'effet sur puce et le bus `'se'` (un effet de priorité plus haute coupe l'autre) ;
- l'intégration à `AudioListener` / `SoundSource` : gain et panoramique calculés par mwg, appliqués au rendu de l'effet ;
- les **sous-titres** : `onCaption` déclenché par un effet de puce comme par un son classique ;
- les effets **déterministes** (aucun hasard non contrôlé : le paquet utilise un générateur à graine fixe) pour que
  l'audio ne perturbe jamais une simulation en pas verrouillé.

### 1.7 Sauvegardes et déterminisme (P1)

- `BusSnapshot` / `SavedBusTrack` : y ajouter, pour un morceau rétro, l'**identifiant du contenu** (`id@version#sha256`),
  la **position en trames** et le moteur utilisé ; à la restauration, rejouer par `skipFrames`.
- Régler la règle : l'audio n'entre **pas** dans l'état du pas verrouillé (`mwg-lockstep-server`), mais ses
  déclencheurs, eux, doivent être déterministes.
- Synchronisation image / son par un compteur de trames du jeu, pas par l'horloge murale.

### 1.8 Étage de sortie et profils (P2)

Le paquet a un `OutputStage` (anti-repliement, non-linéarité du convertisseur, profils des chaînes analogiques d'origine).

À implémenter : un réglage global « fidèle / propre » appliqué au bus maître, un profil par machine (PAL / NTSC,
Atari ST, Amiga, etc.), mémorisé dans les préférences du joueur.

### 1.9 Export du rendu en WAV, FLAC et Opus (P1)

**Partage des rôles.** Le module fait tout ce qui transforme des échantillons en octets ; mwg fait tout ce qui touche
au fichier, à l'utilisateur et à la plateforme.

| Fourni par le module (fait, testé) | À fournir par mwg |
| --- | --- |
| `exportAudio(source, 'wav' \| 'flac' \| 'opus', options)` → octets ; `exportAudioBlob` → `Blob` avec le bon type MIME ; `AUDIO_FORMATS` (extension, type MIME) | **Enregistrer le fichier** : lien de téléchargement, `File System Access`, Capacitor / Electron / Android (les plateformes de mwg), nom de fichier, écrasement |
| WAV 16 bits ; FLAC sans perte 16 / 24 bits en TypeScript pur (aucune dépendance, MD5 et CRC, étiquettes Vorbis) | **Hébergement hors fil principal** d'un export long (Worker) avec annulation ; le module accepte déjà `signal` et `onProgress` |
| Opus (Ogg) par **WebCodecs** : rééchantillonnage 48 kHz, paquets, conteneur Ogg, granule tronquée à la longueur exacte, étiquettes | **Un encodeur Opus de repli** quand `AudioEncoder` manque (Node, anciens navigateurs, certains WebView) : un build WebAssembly de libopus (licence BSD) ou un binaire natif ; le module le prend par l'option `encoder` (`OpusPacketEncoder`) et fait le reste |
| `isOpusEncodingAvailable()` pour griser l'option | **L'interface** : choix du format, débit, profondeur, titre / auteur, barre de progression, message d'erreur lisible |
| Rééchantillonneur hors-ligne sans retard (`resampleStereo`) | **La source du rendu** : rendre une piste du jeu, la musique en cours, ou **enregistrer la sortie du bus** (`MediaStreamAudioDestinationNode` + capture) pour exporter ce que le joueur entend, effets compris |
| Rien d'autre : pas de lecture de fichier, pas de décodage | **L'outil en ligne de commande** `mwg-audio convert` : WAV et FLAC marchent tels quels sous Node ; Opus sous Node demande l'encodeur de repli ci-dessus (ou `ffmpeg`) |

À implémenter dans mwg :

- un service `AudioExport` (`mwg/audio`) : `export(source, { format, bitrate, bitsPerSample, tags })` qui appelle
  `exportAudio`, choisit le Worker quand il existe, retire l'option Opus si `isOpusEncodingAvailable()` est faux
  et que le repli n'est pas fourni, et remet un `Blob` ou écrit un fichier selon la plateforme ;
- l'enregistrement du bus (`AudioBus.record()`) : capture de la sortie maître, arrêt, puis export ; la durée est
  bornée comme les rendus (1.4) ;
- un **contrôle de taille** avant l'export (WAV : environ 10 Mo par minute en stéréo 44,1 kHz) ;
- les **étiquettes** par défaut : titre du jeu, nom du morceau, licence de la source (`asset.license`, section 2.1) ;
- l'**essai sur les navigateurs cibles** : le module a été validé sur Chrome 155 (WAV, FLAC et Opus, fichiers relus
  par ffmpeg), pas sur Safari, Firefox ni les WebView Android / iOS. À vérifier avant de promettre Opus partout.

Limites connues du module : FLAC sans étage LPC (les prédicteurs fixes suffisent sur ce type de son, quelques pour
cent de plus qu'un encodeur complet) ; stéréo uniquement ; Opus en stéréo à débit constant ; pas de découpage par
chapitres.

## 2. Contenu et paquets (MWL)

La proposition détaillée est dans [`MWL-PROPOSAL.md`](MWL-PROPOSAL.md) : `package`, `asset`, `character`, `animation`,
`sound_effect`, `music`, `script`, `import`, conteneur `.mwp`, espaces de noms. Ce qu'il faut en plus, et ce qui
est prioritaire :

| Élément | Priorité | Précisions |
| --- | --- | --- |
| Type d'asset `music` (MWA, YM, VGM, NSF, SID, MOD, XM, IT, SMF, XMI, WAV, VOC…) résolu par id ou par chemin | P0 | `loadFile` détecte déjà le format par le contenu |
| Type d'asset `synth-patch` : patchs D-50 (`.syx`) et banques DX7, lus **à la construction** en JSON | P1 | `parseD50SysEx`, `parseDx7Bank` fournissent les structures ; le jeu n'embarque aucune ROM. Voir 2.1 |
| Tag `sound_effect` compilé en `SfxDefinition` | P1 | chemin de données unique, comparable par `diff` |
| `music.fallback` : fichier diffusé pour les plateformes sans le moteur | P2 | évite d'exclure un appareil |
| Commandes `mwl pack / unpack / verify / build` | P1 | `pack` convertit YM / VGM / NSF / DRO / IMF / CMF en MWA (`convertToMwa`) |
| Vérification `sha256` à la charge, limites déclarées (taille, nombre d'entrées, durée audio maximale) | P0 | refus net en cas d'écart |
| `requires.capabilities` (`audio`, `script`…) et politique d'acceptation par le jeu | P0 | un paquet ne doit rien exécuter à l'installation |
| Espaces de noms `id@version` et enregistrement dans les sauvegardes | P1 | deux versions d'un même paquet peuvent coexister |
| Scripts : langage d'expressions pur et borné, pas de JavaScript arbitraire | P1 | `ScriptHost` reste synchrone ; code réel = capacité explicite refusable |
| Intégration i18n (`_()`) des noms et textes d'un paquet, et de `i18n.json` | P1 | extraction par `mwg-i18n` |
| Signature optionnelle des paquets par une clé que le joueur approuve | P3 | utile pour une galerie communautaire |

### 2.1 Banques de patchs : ce que mwg doit prévoir

Constats de l'essai du paquet sur une bibliothèque réelle (687 fichiers, 13 773 patchs D-50 distincts) :

- **Lecture tolérante** : un fichier peut contenir plusieurs banques, des messages corrompus ou d'autres modèles. Le
  paquet ignore ce qui est invalide (somme de contrôle fausse, autre modèle) et garde le reste ; mwg doit en
  faire autant et **signaler** ce qui a été ignoré plutôt que refuser le fichier.
- **Identité d'un patch** : un nom ne suffit pas (11 680 noms distincts pour 40 490 patchs nommés). Utiliser
  `source + emplacement + empreinte du contenu` ; c'est ce qui entre dans la sauvegarde (1.7).
- **Métadonnées exposées** : nom, noms des tons, mode de touches, structure, ondes PCM employées (par nom). Utile pour
  une liste de choix et pour prévenir qu'un patch dépend d'ondes que le modèle ne rend pas (ondes 77-100 du D-50).
- **Licences des banques** : une banque d'un tiers (Bobby Blues, Keyboard Magazine, etc.) reste à son auteur. Le
  champ `asset.license` est obligatoire ici, et `mwl pack` doit refuser un `.syx` sans licence déclarée quand le
  paquet est destiné au partage.
- **Rendu de contrôle à la construction** : rendre une note par patch et signaler les silences ou débordements
  (le paquet en trouve 0,9 % de quasi muets), pour qu'un auteur le sache avant de publier.
- **Aucune ROM** : un `.syx` ne contient que des paramètres. Une image de ROM n'a rien à faire dans ce type d'asset (6).

## 3. Interface et expérience joueur

- **Réglages audio** (P1) : volume par bus, moteur MIDI préféré (SoundFont, MT-32, D-50, OPL…), standard PAL / NTSC,
  mode fidèle / propre, indicateur de charge CPU et d'underrun.
- **Entrée MIDI en direct** (P2) : Web MIDI vers un `MidiSynth` pour jouer au clavier, avec réception de SysEx.
- **Import de patchs** (P2) : glisser-déposer d'un `.syx` (banque D-50, DX7) ; liste des noms lus
  (`D50SysExPatch.name`, `toneNames`), écoute d'un patch, export vers `.mwp`.
- **Visualisation** (P3) : oscilloscope par canal de puce, affichage des motifs d'un tracker (`PlayerInfo`).
- **Aperçu d'un patch** (P1) : un bouton « écouter » (note puis accord, comme `tools/listening/render-patches.ts`) avant
  d'ajouter un patch à un personnage ; avertissement visible quand le patch utilise une onde non rendue.
- **Accessibilité** (P1) : sous-titres des effets (1.6), réglage de la dynamique, réduction des sons aigus / bruit
  blanc (le bruit des ondes D-50 est large bande).

## 4. Outils en ligne de commande

Dans l'esprit de `mwg-smoke`, `mwg-size`, `mwg-i18n`, `mwg-bench` :

| Outil | Rôle | Priorité |
| --- | --- | --- |
| `mwg-audio inspect` | format détecté, puces, durée, boucle, nombre de patchs d'un `.syx` | P1 |
| `mwg-audio convert` | vers MWA ; vers WAV, FLAC et Opus (`exportAudio`, voir 1.9 : l'Opus sous Node demande un encodeur de repli) | P1 |
| `mwg-audio render` | rendu hors-ligne d'un SMF par un moteur nommé | P1 |
| `mwg-audio compare` | distance spectrale entre deux rendus (le paquet a `Compare.ts`) | P2 |
| `mwg-audio budget` | taille et mémoire d'un jeu une fois les rendus pré-calculés | P1 (avec `mwg-size`) |
| Vérificateur `.mwp` | hachages, limites, schéma, capacités demandées | P0 |

## 5. Performance et robustesse

- **Budget de temps** par bloc audio, avec dégradation prévue : moins de voix, désactivation de la réverbération,
  rendu mono (P1).
- **Garde-fous des décodeurs** (P0) : les formats rétro sont des entrées non fiables (NSF, SID et SPC embarquent du
  code machine émulé). Étendre le fuzzing des décodeurs existant (item 376) aux lecteurs du paquet : taille maximale,
  nombre d'instructions émulées par seconde de son, boucles infinies, archives LHA / DEFLATE piégées.
- **Endurance** : un morceau sans fin ne doit jamais bloquer le chargement ni saturer la mémoire.
- **Mobile** : conservation de l'état à la mise en veille du contexte audio (`suspended`), reprise propre.
- **CSP** : le paquet n'exige ni `eval`, ni WebAssembly, ni `blob:` pour les scripts ; l'hôte Worker (1.2) doit
  rester compatible avec la politique par défaut d'mwg (item 374).

## 6. Licences, crédits et conformité

- **Aucune ROM** (P0). La chaîne de contenu doit refuser, à la construction, un paquet qui embarque un fichier
  reconnu comme image de ROM d'un instrument (contrôle par taille et empreinte) et indiquer comment fournir à la
  place un `.syx` de patchs. Les patchs sont des données de l'utilisateur ; les ondes PCM sont **reconstruites**, non copiées.
- **Échantillons tiers** : `asset.license` et `asset.source` obligatoires pour tout média ; affichage dans
  `CREDITS.txt`, généré à partir des paquets présents.
- **Séparation GPL** : le backend YM2149 bit-exact d'Hatari (GPL-2.0-or-later) est un paquet à part
  (`hatari-ym`), branché par `registerChip`. mwg doit garder ce chemin **optionnel** et ne jamais l'inclure par défaut dans un jeu distribué sous une autre licence.
- **SBOM CycloneDX** (item 380) : décrire `@datamoc/mwg-retro-audio` comme dépendance pair optionnelle, avec sa
  licence MPL-2.0 et la mention « aucune ROM ».
- **Noms et marques** : le paquet nomme des instruments (D-50, M1, MT-32) pour décrire ce qu'il modélise ; l'interface
  d'un jeu ne doit pas laisser croire que les sons sont ceux de l'instrument. Libellé suggéré : « modèle sans ROM
  inspiré du Roland D-50 ».

## 7. Tests et vérification côté mwg

- Sous-chemin `testing` : un `FakeRetroPlayer` (rendu déterministe, durée connue) et un contrôleur d'horloge audio.
- **Tests de bout en bout** dans un navigateur réel (`mwg-smoke`) : démarrage du contexte après un geste, lecture,
  bouclage, fondu enchaîné, changement de moteur MIDI, suspension / reprise.
- **Écoute** : le paquet n'a **aucune comparaison à l'oreille ni à du matériel** (voir `CONFORMANCE.md`, repère H).
  Un outil prépare le jeu d'écoute, `tools/listening/render-patches.ts` (`render-patches.ts <dossier de .syx> <sortie> [par famille]`) :
  il choisit quelques patchs par famille (piano, cordes, cuivres, basses, nappes, flûtes, cloches, orgues, leads,
  chœurs, guitares, ondes PCM), rend chacun en WAV normalisé (une note, puis un accord, puis la relâche) et écrit
  `verdicts.csv` (fichier, famille, patch, tons, structure, ondes PCM, colonnes `verdict` et `comment`). À demander à mwg :
  - un **lecteur A / B** dans l'outil de développement (deux sources, bascule sans coupure, niveaux alignés) ;
  - un endroit où **consigner les verdicts** (`ok` / `faux` / `muet`) et les **rejouer** après un changement du moteur,
    pour savoir ce qu'un changement a amélioré ou cassé ;
  - un **jeu de référence versionné** (liste de patchs avec leur empreinte, pas les rendus) pour que deux
    personnes écoutent la même chose ;
  - un indicateur dans `CONFORMANCE.md` qui passe de « jamais écouté » à « écouté par X le jj/mm, verdicts joints »
    quand un jeu a été validé.
  Ce que l'écoute doit trancher : les lois de niveau et de fréquence de coupure du D-50 (non publiées), le sens de la
  balance des partiels, l'appariement des ondes de la ROM aux numéros, la justesse des attaques ajustées.
- Mesures de consommateur (comme pour les autres items) avant toute affirmation de performance.

## 8. Documentation et suivi

- `README.md` et `REFERENCE.md` de mwg : section « Audio rétro », avec l'exemple de `RetroPlayable` et de `retroBusLoader`.
- `API_REPORT.md` / `api-surface.json` : les nouveaux contrats (`MidiSynth`, `AudioCoreHost`, type de son d'effet) doivent y figurer.
- `examples/` : un exemple `retro-audio` (musique, effet, moteur MIDI interchangeable) avec contrôle de fumée navigateur.
- `ROADMAP.md` : un item par ligne de la section 9, numéroté à la suite de `CLOSED.md` ; `CHANGELOG.md` à chaque livraison.
- Version minimale du pair : le paquet déclare `@datamoc/mwg >=0.45.0` (le nom actuel depuis la version 0.45.0).

## 9. Ordre proposé

| Étape | Contenu | Dépend de |
| --- | --- | --- |
| A | 1.3 contrat `Playable`, 1.4 budgets et durées, vérificateur `.mwp`, garde-fous de décodeurs (5) | — |
| B | 1.1 `MidiSynth` + registre de moteurs ; type d'asset `music` ; refus des ROM (6) | A |
| C | 1.6 effets en données et priorités ; sous-titres ; 1.7 sauvegardes | B |
| D | 2 : paquets `.mwp` complets (`character`, `animation`, scripts bornés) ; `mwg-audio` | A, B |
| E | 1.2 hôte Worker / AudioWorklet ; 1.5 musique adaptative | A |
| F | 3 interface (réglages, import et aperçu de patchs, MIDI en direct) ; 7 protocole d'écoute (lecteur A / B, verdicts) ; 2.1 banques de patchs | B, C |

## 10. Questions ouvertes pour les mainteneurs

1. `MidiSynth` doit-il être un contrat de mwg (le paquet s'y conforme) ou un contrat du paquet (mwg le consomme) ?
   La version « contrat de mwg » évite une dépendance du cœur vers le paquet.
2. Le rendu de musique en flux est-il acceptable pour `AudioBus` (qui travaille sur des `AudioBuffer`), ou faut-il
   un second chemin à côté de `Channel` ?
3. Qui possède l'espace de noms des identifiants de paquets (registre central, ou simple convention auteur / nom) ?
4. Politique par défaut face à un paquet qui demande `script` : refuser, demander au joueur, ou exécuter dans un Worker sans réseau ?
5. Les ondes PCM de synthèse (`D50_WAVE_ATTACKS`, `M1_LOOPS`…) sont-elles considérées par mwg comme du contenu
   généré (donc libre) ou comme des données dérivées à signaler dans `CREDITS.txt` ? Le paquet les traite comme
   des descripteurs paramétriques, jamais comme des échantillons.
6. Un patch qui dépend d'une onde non rendue (ondes 77-100 du D-50) doit-il être accepté avec un avertissement, ou
   refusé à la construction ? Le paquet le joue avec une onde de remplacement ; la décision de politique est à mwg.
7. Les verdicts d'écoute sont-ils des données du dépôt de mwg (versionnées, rejouables) ou un journal local de
   chaque auteur ? Le premier cas permet une régression perceptive, le second évite d'alourdir le dépôt.

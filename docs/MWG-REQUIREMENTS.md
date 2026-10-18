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
**Mise à jour du 18 octobre 2026 : la section 11 recense ce que mwg a ajouté depuis 0.46.0, en premier les cœurs
empaquetés pour l'hôte hors fil principal (`factorySource`, 11.1), que ce paquet doit fournir, et un défaut de
`reset()` que ce test a révélé.**

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

### 1.10 Liens de partage : enveloppe publique, contenu libre (P1)

Un lien court qui porte un état de jeu ou une musique, à envoyer dans un message ou à publier. L'**enveloppe est
publique et stable** (n'importe qui peut en fabriquer ou en lire une) ; le **contenu est libre**, défini par chaque
jeu. La démo du piano en est un premier exemple (modèle, réglages, morceau, dichotomie sur les notes).

Enveloppe :

- placée dans le **fragment** de l'URL (`#`) : il n'est jamais envoyé à un serveur, donc les limites de ligne de
  requête des serveurs ne s'appliquent pas ; il ne reste que celles des navigateurs et des messageries ;
- champs : version de l'enveloppe, type de contenu, identifiant du jeu ou du paquet (`id@version`), charge utile,
  somme de contrôle de 2 à 4 octets (détecte un lien coupé par une messagerie) ; le tout compressé en deflate puis
  encodé en base64url ;
- **taille maximale configurable** : 2 000 caractères par défaut (sûr pour une messagerie), jusqu'à 4 093 quand on sait
  que le lien restera dans un navigateur ; au-delà, le lien est tronqué selon les règles du contenu (jamais par
  coupure d'octets) et signalé comme tel ;
- **sécurité** : la charge est une donnée non fiable. Décompression avec budget (`inflateBounded`), validation contre
  le schéma du jeu, aucune exécution ; un lien trop gros, coupé ou invalide échoue proprement sans affecter le jeu ;
- application **après confirmation du joueur** (jamais directement dans une sauvegarde) ; un lien d'une autre version
  du paquet est refusé ou adapté, selon ce que le jeu déclare.

Contenu d'un état de jeu (libre, par jeu) : une graine seule, ou une graine et l'équipement d'un personnage
(identifiant, objets, niveaux, version du contenu). La troncature se fait **par priorité de champ** : la graine
d'abord, l'équipement ensuite, les éléments décoratifs en dernier ; on retire les champs les moins prioritaires
jusqu'à ce que le lien tienne, et le destinataire en est informé.

Critères d'acceptation : un lien produit puis rouvert redonne exactement le même état ; un lien tronqué à
n'importe quel octet est refusé par la somme de contrôle ; un lien hostile (bombe de décompression, schéma faux)
ne dépasse pas le budget et ne casse pas le jeu ; la limite choisie n'est jamais dépassée.

### 1.11 Liens de musique de jeu (P1)

Même enveloppe que 1.10, avec un contenu de type musique.

- **Musique générée** : la graine, l'ambiance, la tonalité, la durée, le moteur (`retro:mt32`, `ym2612`…) et ses
  réglages. Une graine suffit pour une musique générée : le lien reste très court.
- **Musique importée** : les notes du MIDI sont embarquées ; si le lien dépasse la limite, une recherche
  dichotomique garde le plus grand nombre de notes qui tient, et le titre porte « … ».
- **Banques SoundFont** : non transportables (le fichier appartient à l'utilisateur). Le lien le dit et propose un
  modèle du catalogue.
- **Lecture** : une demande de confirmation précède le son, ce qui fournit aussi le geste que les navigateurs
  exigent pour démarrer l'audio.

Critères d'acceptation : le même lien donne la même musique note pour note (graine déterministe, 1.7) ; un morceau
tronqué reste jouable et indique qu'il l'est ; un lien qui désigne un moteur absent retombe sur le repli de 1.1 avec
un événement de diagnostic.

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

Réponses de mwg (octobre 2026, section 11) : **6** accepté avec un avertissement, jamais refusé (crochet
`inspectPatch`) ; **7** ni l'un ni l'autre : des lignes de données indexées par l'identité du patch, que
l'auteur garde où il veut, le dépôt ne tenant que la liste de référence des identités.

## 11. Ce que mwg a ajouté depuis 0.46.0 (non publié) et ce que le paquet peut en tirer

Tout est dans l'arbre de travail de mwg au 18 octobre 2026, non commité ni publié, vérifié par ses tests (plus de 3 300)
et, pour l'hôte hors fil principal, contre les moteurs de ce paquet. Le plus utile pour ce paquet vient en premier.

### 11.1 Cœurs empaquetés pour l'hôte hors fil principal (`factorySource`) : à fournir par le paquet

**La contrainte.** `AudioCoreHost` (mwg, `@datamoc/mwg/audio`) fait tourner un cœur de synthèse dans un Worker. Un
Worker ne reçoit que du **texte** : la fabrique du cœur est envoyée par `Function.prototype.toString`, donc elle ne
peut ni importer ni capturer quoi que ce soit. Les moteurs de ce paquet (`Mt32Synth`, `D50Synth`, `M1Synth`, OPL…)
ont des imports : ils ne passent pas par `factory`.

**Ce que mwg fournit.** L'option `AudioCoreHostOptions.factorySource` : le texte d'une **expression JavaScript dont la
valeur est la fabrique** `(sampleRate) => MidiSynth`, avec ses auxiliaires à l'intérieur. Elle sert à l'hôte en
Worker comme au repli sur le fil principal. Aussi : `host.start(events)` (reset, messages, puis rendu, dans cet
ordre), `prefetch: false` (voir ci-dessous), `playMidiHosted(file, { factorySource, channel, sampleRate })`,
`sendMidiToHost`, `reportUnderruns` et `mwg-audio bench`.

**Ce que le paquet devrait exporter** (item 457 de la feuille de route de mwg, en attente de ce paquet) :

- un sous-chemin construit à la compilation, par exemple `@datamoc/mwg-retro-audio/mwg/worker-cores`, avec
  `retroCoreSource(name: string): string` pour un moteur (`'retro:mt32'`, `'retro:d50'`, `'retro:m1'`, un
  `retro:<id>` du catalogue…) et la liste `retroCoreNames`. Chaque texte est
  `(() => { /* code empaqueté */ return (sampleRate) => new Synth(sampleRate); })()`, **sans `import`/`export`, sans
  `eval`, sans WebAssembly, sans accès au DOM** (un Worker n'en a pas), compatible avec la CSP par défaut de mwg ;
- un texte par moteur plutôt qu'un seul pour tout le catalogue : mesuré, mt32 + dx7 + d50 + le catalogue
  d'instruments pèsent **351 Ko** en un script, ce qui est trop pour un jeu qui n'en joue qu'un ;
- un test dans le paquet qui passe ce texte par l'hôte (recette ci-dessous), pour qu'une dépendance ajoutée à un
  moteur sans être empaquetée casse la compilation et non le jeu.

**Recette de test (faite à la main côté mwg, sans modifier ce paquet).** Empaqueter les moteurs de `dist/` avec
l'esbuild de ce paquet, en IIFE pour une plateforme neutre, qui pose un accesseur global :

```js
// bundle.mjs : entrée = les fabriques de dist/mwg/midiEngines.js (et instrumentEngines.js pour le catalogue)
const entry = `
  import { retroMidiEngines } from '<dist>/mwg/midiEngines.js';
  globalThis.__core = (name) => retroMidiEngines[name];`;
const out = await build({ stdin: { contents: entry, resolveDir: '<racine>', loader: 'js' },
  bundle: true, write: false, format: 'iife', platform: 'neutral', target: 'es2020' });
// la fabrique, sous forme d'expression, est alors :
const source = `(() => {\n${out.outputFiles[0].text}\nreturn (rate) => globalThis.__core('retro:d50')(rate); })()`;
```

puis, côté mwg : `new AudioCoreHost({ factorySource: source, sampleRate: 44100, mode: 'worker', prefetch: false })`,
`sendMidiToHost(host, fichierMidi)` (16 notes tenues), lecture cadencée en temps réel, et comparaison au rendu
direct `renderMidiThroughSynth(fichierMidi, fabrique(44100), { tail: 0 })`. **Critères d'acceptation** : `stats().mode`
vaut `'worker'`, zéro sous-dépassement, et la sortie est **identique à l'échantillon près** à celle du rendu direct.

**Résultats de cette recette** (Windows 11, Node 26) : D-50, MT-32, DX7 **bit-identiques** au rendu direct, D-50 16
voix pendant 30 s sans aucun sous-dépassement alors que le rendu direct seul y consomme 0,96 fois le temps réel
(l'hôte tient donc ce que le fil principal ne tient pas).

**Un défaut de ce paquet révélé par ce test : `reset()` ne ramène pas le cœur à l'état d'origine.** Quand l'hôte a
déjà fait rendre une seconde de silence au cœur puis l'a remis à zéro, MT-32 et D-50 divergent d'un rendu neuf dès
l'échantillon 621 environ (écart efficace de 0,11 pour un signal de 0,25), alors que le DX7 reste identique. La
cause probable (non vérifiée dans le code du paquet) est un générateur de bruit ou une phase de LFO qui garde sa place
à travers `reset()` : qu'un patch chargé survive est voulu, mais le générateur pseudo-aléatoire et les phases ne
devraient pas. Côté mwg c'est contourné (`prefetch: false` : le cœur ne rend rien avant le premier
morceau), mais **`reset()` devrait restaurer le générateur pseudo-aléatoire et les phases**, sinon deux lectures du
même morceau ne sont pas identiques, ce qui compte pour une graine déterministe (1.7) et pour un pas verrouillé.
À corriger avec un test : rendre, `reset()`, rendre à nouveau, comparer.

**Fait côté paquet (18 octobre 2026).** Cause vérifiée dans le code : `D50Synth.reset()` oubliait la phase du chorus
(`chorusPhase`) et le compteur d'âge des voix, et `Vl1.reset()` la phase et le temps de la voix. Le MT-32 et le LAPC-I
héritaient du défaut du D-50 (neuf parties D-50). Corrigé, avec `tests/worker-cores.test.ts` : pour **chacun des 48
moteurs**, rendre du son, `reset()`, rendre à nouveau doit donner exactement la sortie d'un moteur neuf. Le M1 et le
DX7 n'étaient pas touchés, comme vous l'aviez mesuré.

**Fait côté paquet : cœurs empaquetés.** Sous-chemin `@datamoc/mwg-retro-audio/mwg/worker-cores` (construit par
`npm run build`, étape `tools/build-worker-cores.mjs`) :

- `retroCoreNames` : les 48 noms (`retro:mt32`, `retro:dx7`, `retro:d50`, `retro:lapc-i` et un `retro:<id>` par modèle) ;
- `retroCoreSource(name)` : le texte de l'expression `(() => { … return __core.factory; })()`, de valeur
  `(sampleRate) => MidiSynth`, `undefined` pour un nom inconnu ;
- un module par moteur, `@datamoc/mwg-retro-audio/mwg/worker-cores/retro-d50` (défaut : le texte), pour n'embarquer que
  celui-là ; l'index les réunit tous (1,6 Mo au total : à réserver aux outils et aux serveurs).

Chaque texte est empaqueté avec esbuild (IIFE, plateforme neutre, ES2020) à partir de **sa famille de modèles
seulement** : 7 à 62 Ko par moteur (au lieu de 351 Ko d'un seul script ; le MT-32 et le D-50 pèsent moins de 50 Ko).
Aucun ne contient `import`/`export`, `eval`, `new Function`, WebAssembly ni accès au DOM : le test le vérifie, et la
construction échoue si l'un d'eux y revient. Le même test évalue chaque texte comme le fait votre hôte
(`new Function('return (' + texte + ');')()`) et exige que sa sortie soit **identique à l'échantillon près** à celle du
moteur direct, pour les 48 moteurs. Je n'ai pas lancé l'hôte en mode Worker lui-même (il vit dans mwg, que je ne
modifie pas) : à refaire de votre côté avec `retroCoreSource`.

### 11.2 Charge réelle des moteurs (mesurée avec `mwg-audio bench`)

`mwg-audio bench --module <enregistrement> --synth retro:m1 --voices 16 --seconds 600 --rate 44100` enregistre les
moteurs de ce paquet, tient 16 notes et rapporte la part de temps réel utilisée (1 = exactement le temps réel).
Mesures sur cette machine (processeur de bureau, Node 26) :

| Moteur | 16 voix tenues | Durée | Part du temps réel |
| --- | --- | --- | --- |
| `retro:m1` | 601,5 s d'audio en 108 s | 10 minutes | **0,18** |
| `retro:m1` | 31,5 s en 9,6 s | 30 s | 0,30 |
| `retro:d50` | 31,5 s en 44 s | 30 s | **1,41** |
| `retro:d50` | 601,5 s en 515 s | 10 minutes | **0,86** |

Les chiffres de 1.2 (M1 ≈ 1,4, D-50 ≈ 1,1) ne se retrouvent pas ici : le **M1** en utilise moins d'un cinquième du temps
réel et le **D-50** entre 0,86 et 1,41 selon la mesure. Les deux mesures du D-50 diffèrent de 60 % : le banc de 30 s
n'a rien d'autre en parallèle, celui de 10 minutes a tourné pendant que d'autres tâches (tests, navigateurs) occupaient la
machine, ce qui devrait l'alourdir et non l'alléger ; la cause n'est donc pas établie (échauffement du moteur à l'exécution,
voix qui s'éteignent, variation de la machine). À refaire sur la machine de référence, plusieurs fois, avant d'affirmer
un chiffre ; dans les deux cas le D-50 à 16 voix dépasse 0,5, donc le fil principal ne le tient pas avec une marge. Le seuil retenu par mwg : au-delà de 0,5, jouer par
`playMidiHosted`.

**Mesure du paquet (18 octobre 2026), même méthode, 16 voix tenues pendant 10 s à 44,1 kHz, sans hôte** (autre
machine de développement, Node 26) : M1 **0,15**, DX7 0,15, D-50 **0,75**, MT-32 (neuf parties D-50) **1,22**, OPL2
0,34, YM2612 0,18, microKORG 0,04. Cela confirme l'ordre des moteurs : le M1 et le DX7 sont légers, le **D-50 et le
MT-32 sont ceux à jouer par l'hôte** (le MT-32 dépasse le temps réel dès qu'il tient beaucoup de voix sur plusieurs
parties). Les chiffres de 1.2 ne doivent plus être cités sans machine de référence.

### 11.3 Export : Opus et enregistrement du bus

Le paquet a déjà `exportAudio`. Côté mwg, `AudioExport` (service) l'accepte comme **encodeur injecté** pour `flac` et
`opus` (`encoders: { opus: (frames, requête) => octets }`) et s'occupe du reste : formats offerts, contrôle de taille
avant l'export, étiquettes par défaut, annulation, `inWorker` (si l'encodeur est auto-suffisant, voir 11.1), enregistrement
du fichier. mwg a aussi ses propres `webCodecsOpusEncoder` et `oggOpus` (conteneur Ogg Opus, décodé sans erreur par
ffmpeg), donc le paquet n'est pas obligé de fournir Opus ; `AudioBus.record()` (une capture bornée de la sortie du
bus) alimente l'export de ce que le joueur entend.

**Essais d'Opus dans de vrais navigateurs** (mwg, 2 s de sinus 440 Hz à gauche et 660 Hz à droite, 96 kbit/s demandés) :

- **Chrome 155** : 24,8 Ko, relu par `decodeAudioData` : 2 s, 96 000 échantillons exactement, 440 et 660 Hz ;
- **Firefox 158** : encode et relit (2 s, 2 canaux) mais le fichier fait **45 Ko** pour la même consigne : Firefox
  ne tient pas le débit demandé comme Chrome (près de deux fois plus gros). À savoir avant de promettre une taille ;
- **Safari et les WebViews iOS et Android** : non essayés, faute d'appareils.

### 11.4 Banques de patchs et paquets

- `SyxBank` lit maintenant de façon **tolérante** (`readSyx`, `SyxBank.skipped` : octets avant le premier message,
  message non terminé, banque DX7 à somme de contrôle fausse, message d'un autre modèle) ;
- chaque patch a une **identité** `source#message.voix@empreinte` (empreinte FNV-1a 64 bits du contenu), celle que
  doit tenir une sauvegarde : un nom ne suffit pas (11 680 noms pour 40 490 patchs, mesuré par ce paquet en 2.1) ;
- un patch DX7 porte `info` (`dx7VoiceInfo` : algorithme, rétroaction, onde du LFO, transposition) ;
- `SyxBank.audit(synth)` rend une note par patch (chacun choisi par un changement de programme après le chargement de
  la banque) et signale les silencieux et ceux qui saturent. **Pour le D-50 et le M1 le paquet doit dire comment
  choisir une voix** : un `MidiSynth` générique ne sait que « bank puis changement de programme » ;
- `verifyPackage(octets, { shared: true })` et `mwl pack --share` refusent une banque `synth-patch` sans licence ;
- `verifyPackage(octets, { inspectPatch: (octets, actif) => ({ warnings, errors }) })` : **le paquet peut y brancher son
  analyseur D-50** pour signaler les patchs qui dépendent d'ondes non rendues (77-100). Décision de mwg (question 6) :
  un avertissement n'empêche jamais le paquet, une erreur si.

**Fait côté paquet.**

- `inspectD50Patch(octets)` (`@datamoc/mwg-retro-audio/formats`) est l'analyseur à brancher dans `inspectPatch` :
  il rend `{ warnings, errors }`. Un avertissement unique résume les patchs qui demandent les ondes PCM 77-100
  (combinaisons des ondes 1-76, jouées ici par une onde de remplacement), avec les cinq premiers noms et leurs
  numéros d'onde. Un fichier sans message D-50 (une banque DX7, par exemple) ne donne rien ; un fichier illisible
  donne une erreur. Chaque partiel porte maintenant `substituted` (numéro de l'onde demandée) pour qui veut
  faire autrement.
- **Choisir une voix**, par moteur :
  - `retro:d50` : après une banque `.syx`, le **premier** patch est déjà actif ; un changement de programme *n* joue le
    patch d'indice *n* modulo le nombre de patchs, **dans l'ordre de `parseD50SysEx`** (la zone temporaire d'abord, si
    elle est présente, puis les emplacements 1 à 64). Sans banque, le programme choisit l'un des 16 archétypes.
    Une banque chargée survit à `reset()`, comme la mémoire de l'instrument.
  - `retro:mt32` et `retro:lapc-i` : un changement de programme (0-127) choisit une famille de huit programmes, comme
    sur un appareil General MIDI ; les SysEx de timbre sont lus et ignorés.
  - `retro:dx7` : une banque (`F0 43 … 09 20 00`) charge 32 voix et le changement de programme en choisit une ;
    une voix seule remplace la voix courante.
  - **M1 et les autres modèles du catalogue** (`retro:m1`, `retro:ym2612`, …) : le changement de programme et les
    SysEx sont ignorés, le son d'un modèle est celui de ses réglages (`controls` et `presets` de l'instrument). Pour
    auditer plusieurs sons d'un M1, créer l'instrument avec `applyPreset(n)` plutôt que par un programme MIDI.

### 11.5 Autre

- `mwg-audio audit --synth <noms> --module <enregistrement>` : notes d'étalonnage sur chaque moteur, avec repli,
  échec, silence, saturation, décalage continu et hauteur fausse (le partiel le plus fort doit être un harmonique de
  la note). Un bon contrôle de non-régression pour ce paquet, qui a trouvé cinq défauts à la main (VRC6, NES, MMC5,
  YM2612, DAC) ;
- `mwg-audio share make|read` et `core/ShareLink` : lien de partage (état de jeu ou musique) dans le fragment de l'URL,
  somme de contrôle, lecture bornée ; `mwg/music` : musique de jeu générée et déterministe (`composeMusic`,
  `composeStates`, limite de voix pour une puce à 3 voix) ; `AdaptiveMusic` avec bascule sur la mesure ;
  `AudioSettings` branchés à l'écran de réglages ; `generateCredits(…, { support })`.

Réponses aux questions 6 et 7 de la section 10 : voir la fin de cette section 10 ; elles sont décidées côté mwg
(feuille de route, élément 450).

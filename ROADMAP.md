# Roadmap

Cette roadmap suit les évolutions propres à `mwg-retro-audio`. La prise en charge
actuelle et ses limites sont décrites dans [CONFORMANCE.md](CONFORMANCE.md).
Les travaux d'intégration à réaliser dans mwg restent décrits dans
[docs/MWG-REQUIREMENTS.md](docs/MWG-REQUIREMENTS.md).

## Points ouverts

### 1. Compatibilité avec Tone.js

- [x] Proposer une intégration optionnelle avec [Tone.js](https://tonejs.github.io/),
  sans imposer cette dépendance aux utilisateurs du moteur autonome.
  Partager un même `AudioContext`, raccorder la sortie rétro au graphe d'effets
  Tone.js et définir la synchronisation du démarrage et de l'arrêt avec son
  transport. Documenter les limites de synchronisation et de changement de tempo
  des formats historiques, dont les horloges d'origine doivent être préservées.
  Vérifier le démarrage après un geste utilisateur, le volume, l'absence de double
  sortie, l'arrêt et la libération des ressources dans un navigateur réel.
  Consigner la version de Tone.js utilisée pour cette validation.

- [x] Livrer un exemple exécutable dans `examples/tonejs/` : charger un morceau
  rétro avec `loadFile`, le faire jouer à travers un effet Tone.js, et le faire
  coexister avec un synthétiseur Tone.js. Fournir les commandes d'installation et
  de lancement, les contrôles lecture/arrêt, ainsi qu'un fichier de démonstration
  généré ou redistribuable avec sa provenance. Vérifier cet exemple dans un
  navigateur et consigner le résultat.

- [x] Mettre à jour le `README.md` et ajouter `docs/TONEJS.md` : installation,
  contexte audio partagé, routage, synchronisation, cycle de vie et limites.
  Lier l'exemple et préciser la répartition des rôles : formats et synthèse
  historiques côté `mwg-retro-audio`, composition et effets côté Tone.js.
  Mettre à jour `docs/ORGANISATION.md` pour les nouveaux fichiers et
  `CONFORMANCE.md` avec les validations effectivement réalisées.

Livré : `createToneStream`, exemple et [guide](docs/TONEJS.md). Vérifié dans
Chrome 155 sous Windows avec Tone.js 15.1.22 (voir `CONFORMANCE.md`). L'exemple
installe Tone.js localement ; le moteur autonome ne l'importe pas.

### 2. Synthèse simple et profils d'instruments communs

- [x] Fournir une API simple pour choisir un profil, jouer une note, la relâcher
  et jouer des accords, avec vélocité, volume et durée facultative. Réutiliser
  les contrats d'instruments existants et gérer l'allocation des voix.
- [x] Livrer des profils prêts à jouer : piano, piano électrique, orgue, guitare,
  basse, cordes, cuivres, flûte et sons de synthétiseur. Préciser leur méthode de
  synthèse et leurs limites ; distinguer un timbre évocateur d'une reproduction
  fidèle d'instrument acoustique. Permettre de définir ses propres profils.
- [x] Documenter un exemple minimal de quelques lignes, dans l'esprit de l'API
  AudioSynth, et vérifier notes, accords, relâchement et absence de voix bloquées.

Implémentation : `src/instruments/simple.ts`, API et limites dans
[docs/SIMPLE-SYNTH.md](docs/SIMPLE-SYNTH.md), régressions dans `tests/simple.test.ts`.

### 3. Élimination du code inutilisé à la compilation

- [x] Permettre au bundler d'une application de supprimer les modèles, profils,
  lecteurs et tables inutilisés (tree shaking). Proposer des imports ciblés,
  éviter les enregistrements globaux qui retiennent tous les modèles et garder
  la découverte de tous les instruments comme choix explicite.
- [x] Vérifier le résultat sur des applications consommatrices compilées : un
  profil simple seul, une puce seule et le catalogue complet. Mesurer la taille
  des bundles et vérifier l'absence des modules et tables non sélectionnés ;
  la seule déclaration `sideEffects: false` ne constitue pas une validation.
  Documenter les imports recommandés et les mesures reproductibles.

Livré : imports ciblés et enregistrements globaux retirés (`createChip` et
`chipIds` gardent une découverte explicite des 33 variantes) ; catalogue entier
volontaire via `/instruments/catalogue`. `npm run check:bundles` compile, mesure
et valide l'absence des modules non sélectionnés sur trois applications
consommatrices (profil simple seul, puce seule sous trois formes, catalogue
complet du piano), à l'exception unique et documentée du décodeur de voix
`formats/dx7` utilisé par le preset initial du DX7. Mesures et imports :
[docs/BUNDLES.md](docs/BUNDLES.md).

### 4. Exemple de piano interactif pour tous les modèles

Livré dans `examples/piano/` : 46 modèles sélectionnables (neuf profils simples,
PSG, puces à registres de consoles et de micro-ordinateurs, puces FM,
synthétiseurs modélisés et sample DAC sans hauteur musicale), clavier graphique,
entrées ordinateur/souris/MIDI via Web MIDI et panneau adaptatif par modèle.
`node tools/piano-check.mjs` rejoue la validation dans Chrome 155 headless :
chaque modèle produit un signal non nul, les trois modes d'entrée (MIDI simulé
par fausse API), les accords selon la polyphonie, le changement de modèle en
cours de note, la coupure d'urgence, la perte de focus, la restauration des
réglages et la libération à la fermeture — sans erreur console
(`examples/piano/check-results.json`). Les essais avec un clavier MIDI physique
restent à consigner séparément, faute de matériel ; voir
[l'état et les commandes de l'exemple](examples/piano/README.md).

- [x] Créer `examples/piano/`, inspiré du principe de la démonstration AudioSynth,
  avec un graphisme simplifié propre à `mwg-retro-audio` : clavier de piano,
  sélection du modèle, volume et panneau de paramètres.
- [x] Jouer à la souris (appui et relâchement), au clavier de l'ordinateur
  (raccourcis visibles et changement d'octave) et avec un clavier MIDI via
  Web MIDI (choix de l'entrée, vélocité, note-on/note-off et pédale de sustain).
  Permettre les accords selon la polyphonie du modèle. Gérer le refus ou
  l'absence de Web MIDI sans empêcher les autres modes de jeu.
- [x] Rendre sélectionnables tous les modèles de `mwg-retro-audio`, ainsi que les
  profils simples. Adapter automatiquement le panneau aux paramètres exposés
  par le modèle choisi : oscillateurs, enveloppes, filtres, opérateurs FM,
  partiels ou registres pertinents. Afficher les unités, plages, valeurs par
  défaut et limites de polyphonie ; proposer une remise à zéro des réglages.
  Pour les modèles sans hauteur musicale, présenter leurs commandes adaptées.
- [x] Refléter les notes actives sur le clavier graphique et fournir un bouton
  de coupure de toutes les notes. Éviter les notes bloquées lors d'une perte de
  focus, d'une déconnexion MIDI ou d'un changement de modèle ; libérer les
  ressources audio et les écouteurs à la fermeture.
- [x] Documenter installation, lancement, commandes et conditions d'accès à
  Web MIDI. Vérifier l'exemple dans un navigateur, les trois modes d'entrée,
  le panneau de chaque modèle et le changement de modèle pendant une note.
  Consigner séparément les essais avec un clavier MIDI physique et les tests
  simulés. Lier l'exemple depuis le README et mettre à jour la carte du projet.

Les points 2 à 4 ont été réalisés dans ce projet, sans modification d'un autre
projet. Le piano réutilise la couche d'instruments et de contrôles existante ; le
catalogue complet de tous les modèles vit dans `src/instruments/catalogue.ts` et
reste un import explicite, vérifié par `npm run check:bundles` pour ne rien
imposer aux applications consommatrices qui importent un profil ou une puce seule.

### 5. Studio d'enregistrement dans l'exemple de piano

Déjà en place (17 octobre 2026) : le panneau « Enregistrement MIDI » — démarrer /
terminer (notes et pédale de sustain capturées), réécouter la prise sur le modèle
choisi — et le téléchargement du `.mid` écrit par `writeSmf` (`src/formats/midiWrite.ts`,
format 0, validé aller-retour avec `parseSmf`) ; huit morceaux livrés avec la démo et
le fichier `.mid` de l'utilisateur se jouent déjà (sélecteur de fichier unique).
Validé par `tools/piano-check.mjs` avec le MIDI simulé.

- [x] Enregistrer sans clavier MIDI : le panneau n'apparaît aujourd'hui qu'avec une
  entrée MIDI choisie ; permettre de lancer une prise depuis la souris et le clavier
  d'ordinateur, et garder la prise à travers les changements de modèle (elle se
  rejoue sur celui qu'on choisit).
  Livré : le panneau est toujours visible ; une prise faite à la souris ou au clavier
  d'ordinateur survit au changement de modèle, et les notes coupées par ce changement
  sont relâchées dans la prise (elles restaient suspendues auparavant). Vérifié par
  `tools/piano-check.mjs`.
- [x] Rejouer la prise vers une sortie standard et l'enregistrer en fichier : en plus
  du modèle choisi, proposer une voix de rechange « standard » (un profil simple)
  pour comparer la prise à une synthèse générique ; rendre la prise hors ligne
  (`renderPlayer` sur `MidiPlayer` + `InstrumentMidiSink`) puis l'exporter en FLAC ou
  Opus par `exportAudio` — Opus exige WebCodecs, griser le bouton d'après
  `isOpusEncodingAvailable()`.
  Livré : sélecteur « Voix » (modèle choisi ou piano simple standard) pour la
  réécoute et l'export ; « Exporter l'audio » rend la prise hors ligne
  (`MidiPlayer` + `InstrumentMidiSink` + `renderPlayer`, sur une copie de
  l'instrument qui garde ses réglages) puis l'encode en FLAC, Opus ou WAV par
  `exportAudioBlob` ; l'option Opus est grisée quand `isOpusEncodingAvailable()` est
  faux. `tests/take-export.test.ts` décode le FLAC (MD5 vérifié) ; `piano-check`
  vérifie les trois fichiers téléchargés dans Chrome 155.
- [x] Choisir un répertoire de son ordinateur (ou un disque monté, ou une autre
  source) et y lire les MIDI : sélecteur de dossier (`showDirectoryPicker`, Chrome et
  Edge ; repli sur le sélecteur de fichier actuel ailleurs), parcours des `.mid` et
  `.xmi` du dossier, titre repris de l'en-tête du fichier, liste intégrée au
  sélecteur de morceaux, refus ou absence de l'API sans bloquer le reste de l'exemple.
  Livré : la liste de morceaux est désormais une vraie liste d'entrées (morceaux de la
  page, fichiers, dossier, prise — la prise n'écrase plus le fichier ouvert) ; le
  bouton « Dossier de MIDI… » parcourt le dossier et ses sous-dossiers (3 niveaux, 500
  fichiers, 8 Mo par fichier au plus), titre pris dans l'en-tête sinon le nom du
  fichier, fichiers illisibles comptés et ignorés ; hors Chrome et Edge le bouton est
  grisé et le sélecteur de fichiers accepte plusieurs `.mid`/`.xmi`. **Simulé** : le
  sélecteur de dossier est une fausse API dans `piano-check` (liste, abandon, refus,
  absence) ; aucun vrai dossier ni disque monté n'a été essayé.

### 6. Moteurs MIDI pour tous les modèles, banques SoundFont, microKORG

- [x] Exposer chaque modèle du catalogue comme moteur MIDI nommé : `retro:<id>`
  fondé sur `InstrumentMidiSink` (fusion des canaux, percussions omises, voix
  élaguées selon la polyphonie — mélodie et basse gardées), enregistré aux côtés de
  `retro:mt32` / `retro:dx7` / `retro:d50` dans `registerRetroMidiEngines` ;
  validation par les tests d'interopérabilité mwg — `renderMidiThroughSynth` d'un
  fichier réel à travers plusieurs moteurs, signal `onMidiSynthFallback`, rendu non
  nul pour chaque moteur — et liste documentée avec `docs/MWG-REQUIREMENTS.md`.
  Livré : `InstrumentMidiSynth` / `instrumentMidiEngines(définitions)` dans `/mwg` (un
  choix de modèles, sans catalogue) et `/mwg/catalogue` (`registerRetroCatalogueMidiEngines`,
  46 moteurs `retro:<id>` ; `retro:mt32`, `retro:dx7` et `retro:d50` gardent leurs
  moteurs dédiés avec SysEx). Le catalogue n'entre pas dans `/mwg` : `check:bundles`
  le vérifie (`mwgTargeted` 16 Ko, `mwgCatalogue` 169 Ko ; profil et puce seuls
  inchangés). Tests : `tests/mwg-engines.test.ts`.
- [ ] Banques de sons SoundFont : choisir un répertoire de son disque où l'utilisateur
  pose ses `.sf2` et `.sf3`, les lister et y jouer les préréglages — décodage RIFF
  (`sdtp`/`pdta` : échantillons PCM 16 bits, zones, modulateurs essentiels ; le SF3
  remplace les échantillons par de l'Ogg Vorbis et demandera donc un décodeur Vorbis
  que le paquet n'a pas encore, à livrer d'abord pour le SF2), préréglages exposés
  comme modèles jouables (`soundfont:<banque>:<préréglage>` dans le piano, panneau
  adapté, moteur MIDI du point précédent). Aucune banque livrée avec le paquet :
  l'utilisateur ouvre ses propres fichiers, selon la règle « aucune ROM, aucun
  échantillon issu d'une ROM » de `CONFORMANCE.md`.
- [x] Ajouter le Korg microKORG (1999) comme synthétiseur modélisé : deux oscillateurs
  analogiques modélisés et sous-oscillateur, sync et ring modulant, filtre multimode
  à résonance, enveloppes de filtre et d'ampli, LFO, programmes évocateurs des
  banques du microKORG — sans ROM ni échantillon ; le vocodeur et l'accordeur restent
  hors du jeu de notes. Adaptateur d'instrument, entrée explicite dans le catalogue
  (47 modèles), presets exposés, régressions de cycle de vie comme les autres
  synthétiseurs et mesures de bundles mises à jour.
  Livré : `src/chips/MicroKorg.ts` (`MicroKorgSynth`, 4 voix, 15 programmes originaux) et
  son adaptateur dans `src/instruments/synths.ts` ; 47 modèles dans le catalogue, la
  démo et `CONFORMANCE.md` (hors jeu : vocodeur, accordeur, DWGS, arpégiateur, modes
  mono et unisson, effets). Aucune ROM ni échantillon. `tests/microkorg.test.ts` mesure
  justesse, filtres, résonance, ring, sync, enveloppes et polyphonie ; mesures de
  bundles : catalogue 159 007 o (profil et puce seuls inchangés).

Les points 5 et 6 restent réalisables dans ce projet, sans modification d'un autre ;
SoundFonts et microKORG ajoutent leurs modules propres et ne doivent rien imposer aux
imports ciblés (à vérifier par `npm run check:bundles` comme pour les autres modèles).

# Piano interactif — tous les modèles du catalogue

Depuis la racine : `npm install`, puis `npm start --prefix examples/piano`.
Ouvrir http://127.0.0.1:4173 et activer le son (le navigateur exige un geste
utilisateur pour démarrer l’audio). Le serveur local s’arrête avec `Ctrl+C`.

Jouer avec la souris ou les touches A W S E D F T G Y H U J K. Z et X changent
l’octave ; le champ Octave permet aussi de la choisir. Le choix de modèle
reconstruit le panneau de paramètres, avec unités, plages, valeurs par défaut,
défauts et limites de polyphonie affichés. Les notes actives sont mises en
évidence sur le clavier graphique ; « Couper les notes » arrête tout. Le volume
général est indépendant du volume propre au modèle. La touche « Réglages par
défaut » remet les paramètres du modèle choisi.

« Connecter MIDI » demande l’accès Web MIDI sans SysEx. Cette API exige un
contexte sécurisé (HTTPS ou localhost) et un navigateur compatible. Choisir
l’entrée après autorisation. Note-on, note-off, vélocité, sustain (CC 64) et
all-notes-off (CC 120/123) sont gérés ; un refus ou l’absence de Web MIDI laisse
les autres modes disponibles. La déconnexion, la perte de focus et le changement
de modèle relâchent les notes ; la fermeture de la page libère le contexte audio
et les écouteurs.

## Catalogue

48 modèles jouables, issus du catalogue explicite `src/instruments/catalogue.ts`:

- neuf profils simples (piano, piano électrique, orgue, guitare, basse, cordes,
  cuivres, flûte, synthé) ;
- YM2149 et AY-3-8910 ;
- D-50, M1, microKORG, GS-1, VL-1, DX7, synthèse additive Bell Labs et Dartmouth,
  Synclavier, structures LA/AI, MT-32 et sa carte PC Roland LAPC-I ;
- SN76489 et Tandy, MOS 6581 et 8580 (SID), APU NES NTSC et PAL, VRC6, MMC5,
  Sunsoft 5B, Namco 163 et Famicom Disk System ;
- OPL2, OPL3 et Sound Blaster, YM2612, YM2203, YM2608 et YM2151 ;
- SAA1099, C/MS, PC speaker, Mockingboard et Apple II ;
- Sample DAC (Covox) — sans hauteur musicale : ses commandes sont adaptées
  (niveau maximal et panoramique).

## Validation

`node tools/piano-check.mjs` rejoue l’exemple dans Chrome sans interface
(playwright-core, dépendance du projet voisin `../mwg`) : chaque modèle construit
son panneau, produit un signal non nul au clavier d’ordinateur, à la souris et en
MIDI simulé, les accords tiennent selon la polyphonie, le changement de modèle en
cours de note, la coupure d’urgence, la perte de focus, la restauration des
réglages, la déconnexion MIDI, le refus et l’absence de Web MIDI et la libération
du contexte à la fermeture sont vérifiés. Résultat détaillé :
`check-results.json` dans ce dossier.

Du 18 octobre 2026 : 48 modèles, 0 problème, sans erreur console (46 modèles le 17 octobre, avant le microKORG).

Le MIDI est simulé par une fausse API Web MIDI injectée dans la page : les
messages note-on/off, vélocité, sustain et all-notes-off sont bien exercés côté
application, mais **aucun clavier MIDI physique n’a encore été essayé** ; cet
essai là devra être consigné séparément.

Limites : le pitch bend continu n’est pas implémenté par les adaptateurs de
synthétiseurs historiques (leur description l’indique) ; les notes sans hauteur
(Sample DAC) jouent une tension, pas une fréquence. Cette validation ne constitue
pas une comparaison à l’oreille.

## Lecture automatique, machines et sons préréglés

- Les boutons de machine (Atari ST, Commodore 64, NES, Mega Drive…) et la liste
  groupée (ordinateurs, consoles, cartes son, synthétiseurs) disent quel
  ordinateur ou quelle console portait chaque composant (`machines.ts`). Le
  YM2149 est choisi par défaut : c'est la puce de l'Atari ST.
- Les sons préréglés du modèle (pour le YM2149 : « Buzz bass », « Triangle buzz »,
  enveloppe matérielle…) sont des boutons sous la description.
- « Lecture automatique » joue un des huit morceaux MIDI (dossier `music/`,
  copiés de `pontifex/assets/music`) sur le modèle choisi, ou un fichier .mid de
  l'utilisateur ; changer de modèle repart du début du morceau. `InstrumentMidiSink`
  fusionne les canaux, omet les percussions et, quand la puce manque de voix,
  garde la mélodie et la basse.
- Provenance des MIDI (`music/`, issus de `pontifex/assets/credits.json`) : Theme Song
  [8-bit] (nene) et Ancient Mysteries (Sperry Lion, LLC, 2024), CC0 d'après
  opengameart.org (vérifié le 17 octobre 2026) ; Marche turque, Les Sauvages,
  Symphonies n°5 et n°7, Gymnopédie n°1 : domaine public, saisies Mutopia Project.
  « Méditation de Thaïs » : l'œuvre de Massenet († 1912) est dans le domaine
  public, mais le fichier MIDI (`THAIS.MID`, séquenceur non identifié) n'a pas de
  licence établie (pontifex le dit « non renseignée », son README parle de
  CC BY-SA 4.0) ; conservé à la demande de l'auteur du projet. Le badge « powered by mwg » vient de
  `pontifex/assets/powered-by-mwg.svg`.

## Enregistrement MIDI

Quand une entrée MIDI est choisie, un panneau « Enregistrement MIDI » apparaît :
« Enregistrer » garde les notes jouées (clavier MIDI, souris, clavier d'ordinateur)
et la pédale de sustain ; « Terminer » coupe le silence avant la première note et
relâche les notes restées enfoncées ; « Réécouter » rejoue la prise sur le modèle
choisi (changer de modèle pour comparer) ; « Télécharger .mid » exporte un fichier
MIDI standard (format 0, 480 pulsations par noire, 120 battements par minute) écrit
par `writeSmf` (`src/formats/midiWrite.ts`). La prise reste disponible après la
déconnexion du clavier ; « Effacer » la supprime. Elle n'est conservée qu'en mémoire
de la page. Validé par `tools/piano-check.mjs` avec le MIDI simulé ; aucun clavier
physique n'a encore été essayé.

## Voix standard, export audio, dossier de MIDI

- « Voix du morceau » (panneau de lecture) choisit le son de tous les morceaux, prise
  comprise : le modèle choisi, ou un piano simple (« standard ») pour comparer à une
  synthèse générique.
- Le panneau « Export audio du morceau courant » est séparé de l'enregistrement : il
  rend hors ligne le morceau sélectionné dans la liste (morceau livré, fichier, dossier
  ou dernière prise), avec la voix choisie, et le télécharge en FLAC, Opus ou WAV, avec une
  barre de progression (`renderPlayerAsync`, qui rend la main au navigateur). Opus demande
  WebCodecs (Chrome, Edge) : l'option est grisée ailleurs.
- « Dossier de MIDI… » (Chrome et Edge, `showDirectoryPicker`) liste les `.mid`, `.midi`
  et `.xmi` d'un dossier de l'ordinateur ou d'un disque monté ; ailleurs, « Votre
  fichier .mid » accepte plusieurs fichiers. Essayé seulement avec une fausse API de
  sélecteur de dossier.

## Banques SoundFont

La section « Banques SoundFont » ouvre vos propres fichiers `.sf2` (bouton « Dossier de
banques… » sous Chrome et Edge, sinon « Votre fichier .sf2 ») ; chaque préréglage de la
banque devient un modèle jouable, au bas de la liste, avec un panneau (gain, panoramique,
temps d'attaque et de relâchement, filtre, boucles). Aucune banque n'est livrée avec la page.
Le SF3 (Vorbis, Opus ou FLAC) est refusé avec un message qui renvoie à mwg : `@datamoc/mwg`
0.46 lit et décode les banques SF3 (`loadSoundFont`, outil `mwg-soundfonts convert`), cette
démo autonome restant SoundFont 2 ; sous-ensemble de la norme lu et joué : voir
`CONFORMANCE.md`. Validé avec des banques fabriquées par `tests/sf2file.ts`, jamais avec une
banque réelle.

## Page autonome

`npm run build:demo` génère `examples/piano/synth-demo.html` : un seul fichier
(JS inliné, environ 150 Ko) qui s'ouvre directement par double-clic, sans serveur
local ni `npm install`. Web MIDI y reste dépendant du navigateur et du contexte
(souvent indisponible en `file://`) ; clavier et souris fonctionnent.

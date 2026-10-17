# Utiliser Tone.js avec mwg-retro-audio

Tone.js gère les effets, les séquences et son transport musical. Le moteur rétro
garde la lecture des fichiers, les registres et les horloges des machines.
L'adaptateur n'importe pas Tone.js : sa dépendance reste propre à l'application.

## Installation et exemple

Depuis la racine, avec Node.js 20.19 ou supérieur :

```sh
npm install
npm install --prefix examples/tonejs
npm start --prefix examples/tonejs
```

Ouvrir `http://127.0.0.1:4173`, puis cliquer sur « Jouer ensemble » pour autoriser
le son. L'exemple utilise Tone.js 15.1.22, une mélodie YM originale générée dans
`examples/tonejs/melody.ts` (MPL-2.0), un delay et une basse Tone.js. Aucun média
extérieur ou ROM n'est requis. Le volume agit sur les deux sources.

## Contexte partagé et routage

```ts
import * as Tone from 'tone';
import { loadFile } from '@datamoc/mwg-retro-audio/formats';
import { createToneStream } from '@datamoc/mwg-retro-audio/driver/tone';

await Tone.start(); // dans un gestionnaire de geste utilisateur
const context = Tone.getContext().rawContext;
const effect = new Tone.FeedbackDelay(0.25, 0.2).toDestination();
const player = loadFile(bytes, { sampleRate: context.sampleRate });
const retro = createToneStream(Tone, effect, player);
retro.stream.start(Tone.now() + 0.1);
// Fin de lecture ou démontage de l'interface :
retro.dispose();
effect.dispose();
```

L'adaptateur crée un `GainNode` natif connecté au seul nœud Tone fourni. Il ne
crée pas de seconde connexion vers les haut-parleurs. `retro.input.gain` permet
de régler la source rétro seule ; un `Tone.Volume` après le mélange agit sur
l'ensemble. `dispose` coupe les sources et déconnecte l'entrée ; l'application
reste propriétaire des effets et du contexte partagé, qui n'est pas fermé.

## Synchronisation et limites

Utiliser le même instant absolu pour `retro.stream.start(when)` et
`Tone.getTransport().start(when, 0)`, comme dans l'exemple. Arrêter les deux
explicitement avec `retro.stream.stop()` et `transport.stop()`. Pour rejouer le
fichier depuis le début, appeler `player.reset()` avant un nouveau démarrage.
L'adaptateur ne s'abonne pas automatiquement au transport : pause, recherche et
boucles du transport ne repositionnent pas le lecteur rétro.

Le rendu rétro est anticipé par blocs sur le fil principal. Les changements
interactifs peuvent attendre la durée déjà planifiée ; une surcharge peut
produire une interruption. Les changements de BPM de Tone ne changent pas les
horloges PAL/NTSC ni la vitesse du fichier. Une suspension du contexte gèle son
horloge ; `Tone.start()` permet de le reprendre après un geste utilisateur.
Ne pas fermer le contexte partagé pour arrêter uniquement le lecteur rétro.

## Vérification

Les tests `tests/webaudio.test.ts` vérifient le routage, l'heure de démarrage,
la libération des sources et l'annulation des anciennes notifications de fin.
Ils utilisent un faux contexte ; ils ne remplacent pas l'essai navigateur.
La validation réelle doit contrôler démarrage par clic, signal non nul des deux
sources, volume, arrêt, redémarrage et absence d'erreurs console. Les résultats
effectivement observés sont consignés séparément avant clôture de la roadmap.

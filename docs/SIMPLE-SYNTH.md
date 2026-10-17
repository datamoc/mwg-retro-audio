# Profils de synthèse simples

```ts
import { SimpleInstrument, piano } from '@datamoc/mwg-retro-audio/instruments/simple';

const instrument = new SimpleInstrument(piano, { sampleRate: 44100 });
instrument.play([60, 64, 67], 0.5, 100); // accord, secondes, vélocité MIDI
const left = new Float32Array(44100);
const right = new Float32Array(44100);
instrument.render(left, right, 0, left.length);
```

Ce code produit du PCM stéréo ; il ne lance pas seul une sortie audio. Les durées
avancent avec `render`, ce qui permet aussi le rendu hors ligne sans minuterie.
Les buffers reçoivent le signal par addition. Utiliser `noteOn` / `noteOff` pour
une durée contrôlée par un clavier, `sustain` pour la pédale, `pitchBend` pour la
hauteur et `allNotesOff` pour relâcher les notes et désactiver la pédale.
`reset` coupe immédiatement les voix et rétablit le volume par défaut.

Profils fournis : `piano`, `electricPiano`, `organ`, `guitar`, `bass`, `strings`,
`brass`, `flute`, `synth`. Ils combinent des harmoniques sinusoïdales avec une
enveloppe ADSR. Ce sont des timbres évocateurs, pas des reproductions acoustiques
fidèles. Les harmoniques au-dessus de Nyquist sont omises. Aucun échantillon ni
ROM n'est utilisé. Le volume est un contrôle exposé dans `instrument.controls`.

Un profil personnalisé fournit `name`, `harmonics` (amplitudes successives),
`attack`, `decay`, `release` en secondes et `sustain` entre zéro et un. Le
constructeur accepte en troisième argument la polyphonie (16 par défaut) ; la
voix la plus ancienne est remplacée lorsqu'il n'y a plus de place. Le niveau
est divisé par la polyphonie pour garder de la marge lors des accords.

Importer uniquement les profils nécessaires depuis `/instruments/simple`.
L'import d'une puce précise est également possible, par exemple
`@datamoc/mwg-retro-audio/chips/Ym2149`. Les mesures de bundles et les exemples
interactifs restent suivis dans la roadmap.

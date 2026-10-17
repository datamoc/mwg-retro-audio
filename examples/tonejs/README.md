# Tone.js et mwg-retro-audio

Depuis la racine :

```sh
npm install
npm install --prefix examples/tonejs
npm start --prefix examples/tonejs
```

Ouvrir http://127.0.0.1:4173 et cliquer sur « Jouer ensemble ». Le bouton Arrêter
libère les sources, l'événement du transport et les effets. Le volume est commun
aux deux moteurs. L'exemple fonctionne avec Tone.js 15.1.22, installé localement.
Le serveur n'écoute que l'interface locale. `Ctrl+C` l'arrête.

La mélodie de `melody.ts` est générée, originale, sous MPL-2.0 comme le projet ;
elle ne dépend d'aucun enregistrement ni ROM. Voir [le guide](../../docs/TONEJS.md)
pour le partage du contexte, les imports et les limites de synchronisation.

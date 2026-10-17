# listening

Prépare un jeu d'écoute pour comparer le rendu de `D50Synth` à l'oreille.

```sh
node --import tsx tools/listening/render-patches.ts <dossier de .syx / .d50> <dossier de sortie> [par famille=3] [formats=wav]
```

- choisit quelques patchs par famille (répartis sur la liste triée, donc issus de banques différentes) ;
- rend chaque patch en WAV 16 bits 44,1 kHz : une note (C4, 2,5 s), la relâche, un accord (C2 C4 E4 G4, 3 s), la relâche ;
- les rendus sont **normalisés** (on compare des timbres, pas des niveaux) ;
- écrit `verdicts.csv` : à remplir, colonne `verdict` = `ok` / `faux` / `muet`, plus un commentaire.

Les patchs appartiennent à leurs auteurs et les rendus sont l'interprétation du moteur : rien de tout cela n'est
versionné. Sortie conseillée : `download/listening/` (ignoré par git).

`formats` : liste séparée par des virgules parmi `wav`, `flac`, `opus` (l'Opus passe par `ffmpeg` sous Node, qui n'a pas WebCodecs).

# Imports ciblés et élimination du code inutilisé

Le paquet livre des modules ES, avec `sideEffects: false`. Une application
compilée peut importer un seul profil ou une seule puce :

```ts
import { SimpleInstrument, piano } from '@datamoc/mwg-retro-audio/instruments/simple';
import { Ym2149 } from '@datamoc/mwg-retro-audio/chips/Ym2149';
import { loadYm } from '@datamoc/mwg-retro-audio/formats/ym';
import { RetroStream } from '@datamoc/mwg-retro-audio/driver/RetroStream';
```

Ces imports n'imposent pas le chargement du catalogue complet. Les sous-chemins
correspondent aux noms des modules et sont sensibles à la casse. Le chargeur
universel `loadFile` doit connaître tous ses décodeurs : choisir un lecteur
spécifique lorsqu'un seul format est nécessaire. L'import du catalogue complet
reste volontaire, par exemple pour une interface de sélection de tous les modèles.

## Mesures reproductibles

Lancer `npm run check:bundles`. Le script compile des applications consommatrices
à partir des exports publiés dans `dist`, avec esbuild 0.28.2, puis vérifie le
métagraphe des modules réellement retenus et le contenu du bundle. Les résultats
détaillés sont écrits dans [bundle-results.json](bundle-results.json).

Mesure du 17 octobre 2026, code minifié (octets ; gzip à titre comparatif) :

| Application | Minifié | Gzip |
| --- | ---: | ---: |
| Profil piano seul | 4 505 | 1 809 |
| YM2149 seul | 3 170 | 1 343 |
| YM2149 depuis `/chips` | 3 170 | 1 344 |
| YM2149 depuis l'entrée principale | 3 170 | 1 344 |
| Catalogue complet des instruments (`/instruments/catalogue`) | 160 363 | 51 152 |
| Moteurs MIDI nommés, un choix de modèles (`/mwg` + `/instruments/psg`) | 16 163 | 5 848 |
| Moteurs MIDI nommés, les 48 modèles (`/mwg/catalogue`) | 180 610 | 58 775 |
| Lecteur de banques SoundFont seul (`/formats/soundfont`) | 7 044 | 2 872 |
| Instruments SoundFont (`/instruments/soundfont`, lecteur et synthèse compris) | 7 986 | 3 171 |
| Exports des puces et instruments disponibles | 118 603 | 37 751 |

Le contrôle refuse un bundle de profil simple contenant les émulateurs,
les parseurs ou le catalogue ; un profil seul ne retient que quatre modules.
Le contrôle de la puce refuse notamment les tables D-50/M1, le DX7, le SID, la
NES et tout module d'instruments. Le contrôle du catalogue vérifie que chaque
module d'instruments est bien présent et qu'aucun lecteur de fichiers n'est
embarqué (seule exception admise : le décodeur de voix `formats/dx7`, utilisé
par le preset initial du DX7). Ces chiffres décrivent les applications de
contrôle, sans interface ni Tone.js ; ils ne sont pas une promesse de taille
pour toutes les applications et tous les bundlers.

Les fabriques intégrées sont décrites par des données sans appels globaux à
`registerChip`. `createChip` et `chipIds` conservent la découverte explicite des
33 variantes ; une fabrique personnalisée enregistrée reste prioritaire.
Le catalogue d'instruments d'interface s'importe explicitement depuis
`/instruments/catalogue` : il couvre les 48 modèles jouables du paquet (neuf
profils simples et 37 puces ou synthétiseurs), et reste un choix volontaire
de l'application, jamais une dépendance implicite d'un import ciblé.

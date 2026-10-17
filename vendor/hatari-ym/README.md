# hatari-ym — le son de l'Atari ST, en TypeScript, à l'échantillon près

Port TypeScript fidèle de la chaîne sonore de **Hatari 2.5.0** (YM2149 et étage de sortie de l'Atari STF).
Alimenté avec les mêmes écritures de registres, aux mêmes instants, il produit **les mêmes échantillons que
Hatari, bit pour bit**.

## Preuve

La référence est l'audio que Hatari a réellement produit : le flux PCM d'un enregistrement AVI fait par Hatari
lui-même (`--avirecord`), qui stocke son tampon de sortie tel quel. La trace des écritures YM vient de
`hatari --trace psg_write,video_vbl`. Le synthétiseur rejoue cette trace, depuis le démarrage de la machine,
et on compare chaque échantillon :

| Enregistrement | Durée | Échantillons comparés | Identiques | Écart max |
|---|---|---|---|---|
| calib | 74,9 s | 3 305 435 | 3 305 435 (100 %) | 0 |
| calib2 (bruit, tons) | 74,9 s | 3 305 436 | 3 305 436 (100 %) | 0 |
| Airball, morceau 1 | 169,9 s | 7 492 327 | 7 492 327 (100 %) | 0 |
| Airball, morceau 2 | 169,9 s | 7 492 327 | 7 492 327 (100 %) | 0 |
| Airball, morceau 3 | 169,9 s | 7 492 327 | 7 492 327 (100 %) | 0 |
| Airball, morceau 4 | 169,9 s | 7 492 325 | 7 492 325 (100 %) | 0 |
| Airball, morceau 5 | 169,9 s | 7 492 326 | 7 492 326 (100 %) | 0 |
| Airball, morceau 2 (long) | 516,3 s | 22 770 804 | 22 770 804 (100 %) | 0 |
| **Total** | **25,2 min** | **66 843 307** | **100 %** | **0** |

Seule nuance : sur la capture de 516 s, Hatari a écrit un échantillon de plus à la toute fin de l'enregistrement
(22 770 805 contre 22 770 804) ; les 22 770 804 premiers sont identiques.

Les tests de non-régression (`npm test`) rejouent deux de ces enregistrements à partir des fichiers de
`test/fixtures/` et comparent le **SHA-256** du résultat à celui de l'audio produit par Hatari.

## Ce qui est reproduit

Tout ce que fait Hatari entre l'écriture d'un registre et l'échantillon de sortie, avec les mêmes types entiers
que le code C (`int32`, `uint32`, `int64`, `int16`) :

1. **YM2149 cycle par cycle à 250 kHz** : compteurs de tons, de bruit (à 125 kHz) et d'enveloppe, registre à
   décalage 17 bits du bruit, 16 formes d'enveloppe.
2. **Mélange des 3 voix** par la table de niveaux **mesurée sur un vrai ST** (16×16×16 valeurs, interpolée sur
   5 bits comme dans `interpolate_volumetable`).
3. **Filtre passe-bas asymétrique de l'étage de sortie du STF** (C10/R8, appliqué à 250 kHz).
4. **Rééchantillonnage exact 250 663 Hz → 44 100 Hz** par moyenne pondérée (fractions 16.16).
5. **Filtre sous-sonique IIR** (décalage arithmétique, comme Hatari 2.5.0).
6. **Conversion des cycles CPU en ticks YM** (`ClocksTimings_ConvertCycles`, reste cumulé) : le résultat ne
   dépend pas du découpage des appels à `update()`, comme dans Hatari.

## Utilisation

Node 22.18 ou plus récent (il exécute directement le TypeScript).

```ts
import { HatariYm } from 'hatari-ym';

const ym = new HatariYm();            // Atari STF PAL, 44,1 kHz
ym.reset(0);
// l'horloge est celle du CPU (8 021 247 Hz) ; chaque écriture est datée à son cycle
ym.writeData(1000, 0, 0x38);          // période de la voix A, octet bas
ym.writeData(1060, 1, 0x02);          // octet haut
ym.writeData(1120, 8, 15);            // volume de la voix A
ym.writeData(1180, 7, 0x3e);          // mélangeur : ton A seulement
ym.update(8021247);                   // génère jusqu'à 1 s de CPU
const pcm: Int16Array = ym.takeSamples();   // mono ; Hatari duplique l'échantillon sur les 2 voies
```

### Rejouer une trace Hatari

```bash
hatari --trace psg_write,video_vbl --trace-file trace.txt ...      # produit la trace
node src/cli.ts render trace.txt sortie.wav
```

```ts
import { readTrace, renderTrace } from 'hatari-ym';
const pcm = renderTrace(await readTrace('trace.txt'));
```

### Rejouer un flux de registres issu d'un pilote sonore

`renderRegisterFrames(frames)` écrit chaque instantané registre par registre, comme le ferait une routine
d'interruption (60 cycles entre deux écritures, 245,76 Hz par défaut, ordre 10 → 0). **Tout ce qui suit les
écritures de registres est exact ; leur instant exact dans le tick est une approximation**, sauf si on le
fournit avec une trace.

## Datation des écritures

Hatari date chaque écriture avec `Cycles_GetClockCounterOnWriteAccess()`. La trace donne le compteur de trame
(`FrameCycles`) et la longueur de chaque trame ; l'horloge globale vaut donc

```
horloge = somme des longueurs des trames écoulées + FrameCycles + HATARI_TRACE_ORIGIN   (= −44)
```

`HATARI_TRACE_ORIGIN = −44` a été calibrée une fois, par balayage, sur Hatari 2.5.0 (STF, EmuTOS) : c'est la seule
valeur pour laquelle 25 minutes d'enregistrement sont identiques. Les valeurs voisines donnent de 38 à 97 % de
concordance seulement, ce qui montre la sensibilité de la mesure (une erreur d'un tick YM décale la phase du
registre à décalage du bruit pour tout le reste de l'enregistrement).

## Limites

- Configuration par défaut de Hatari **STF PAL, 44 100 Hz** : filtre de sortie STF, filtre sous-sonique, moyenne
  pondérée. Les autres machines (STE, TT, Falcon) et les autres fréquences de sortie ne sont pas vérifiées. Le filtre
  `PWM` est porté (option `lowPass: 'pwm'`) mais ne correspond pas aux enregistrements : c'est bien le filtre
  STF qui est à l'œuvre dans l'audio de référence.
- Le résultat n'est exact que si les écritures sont **datées comme dans Hatari**. La datation fine dépend de
  l'instruction 68000 qui écrit (états d'attente du bus, `CurrentInstrCycles`) ; ce paquet la reprend des traces.
- Le **mode enveloppe** (bit 4 des registres de volume) est émulé comme dans Hatari, mais il n'est exercé que par
  les enregistrements d'Airball (voix à volume 255) ; le registre 13 n'est écrit dans aucun d'eux pendant la
  capture, donc les formes d'enveloppe non triviales n'ont pas été comparées.
- Aucune émulation du reste de l'Atari (MFP, DMA, STE, IKBD).

## Développement

```bash
npm install
npm run typecheck      # tsc strict
npm test               # 6 tests, dont 2 comparaisons bit à bit avec l'audio de Hatari
node scripts/make-fixture.ts <nom> <trace.txt> <reference.s16le>    # nouveau jeu de test
node test/validate.ts <trace.txt> <reference.s16le> [origine ...]  # compare avec un PCM de Hatari
```

Référence PCM depuis un AVI Hatari :
`ffmpeg -i rec.avi -vn -af "pan=mono|c0=c0" -f s16le -acodec pcm_s16le ref.s16le`

## Licence

GNU GPL v2 ou ultérieure, comme Hatari dont ce code est dérivé (voir `LICENSE` et `NOTICE`). La table de
volume (`src/volumeTable.ts`) provient des mesures de Paulo Simoes publiées dans Hatari.

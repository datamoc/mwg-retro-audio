# rom-analysis

Offline tools that measure the user's own ROM dumps of the Roland D-50 and Korg M1 to fit the ROM-free models of
`@datamoc/mwg-retro-audio` (`D50Synth`, `M1Synth`). They are **not part of the package** (`package.json` `files`
excludes them) and the ROMs are **never copied into the repository**: read them from any folder, for example the
git-ignored `download/`.

Only parametric descriptors come out (harmonic amplitudes, partial ratios and decays, noise bursts). No sample, wave
table or ROM byte may enter `src/`.

## What was measured on the dumps

- **D-50**: `roland__r15179858...ic30` (512 KB) is exactly `ic30 + ic29` of the D-50. Its byte pairs are put back in
  order with the bit permutation of Munt's `Synth::loadPCMROM` and give a sign and a 15 bit logarithmic magnitude (larger
  = louder, 2048 steps per octave, Munt's `unlog`): the waveforms come out smooth and periodic. A first attempt that
  rebuilt the top magnitude bit by continuity drifted and was replaced. Sample rate 32 kHz. See `la32.py`.
- **M1**: `korgm1p1/ic40..ic43` (the internal sample ROM) are signed 8 bit high bytes of 16 bit samples, `u201..u204`
  (the Plus-1 expansion ROM, next to `plus-1_*.bin`) are 16 bit little-endian samples (`m1rom.py`). The sample rate is not in the dumps: 44.1 kHz is assumed.

## Usage (Python 3 with numpy and scipy, Node 22+ for the renderer)

```sh
# D-50 attacks -> bank -> held-out distance
python run_fit.py <d50 512KB ic30> fits.json
python build_bank.py fits.json old_bank.json new_bank.json --train all   # old_bank.json lists the roles (names)
MW_RATE=32000 python evaluate.py <d50 512KB ic30> fits.json new_bank.json --test odd
python emit_ts.py new_bank.json            # body of D50_ATTACKS in src/chips/historical.ts

# D-50 per-wave descriptors (attacks and looped pages of the ROM, in ROM order) -> src/chips/d50Waves.ts
python emit_d50_waves.py <d50 512KB ic30> > ../../src/chips/d50Waves.ts

# M1: steady spectra and attacks
python run_m1.py <folder with korgm1p1/> frames.json
python eval_loops.py frames.json 16        # train on ic*, test on u*; writes frames_bank.json
MW_RATE=44100 python run_m1_attacks.py <folder with korgm1p1/> m1a
python build_bank.py m1a_fits.json roles.json bank.json --train all
python emit_m1_ts.py frames_bank.json bank.json > ../../src/chips/m1Data.ts
```

`evaluate.py` renders every recipe of a bank with `render-bank.ts` (the package's own renderer) at the pitch of each
recorded attack and reports the mean log-mel distance (dB) of the best recipe; see `closeness.py`.

"""Korg M1 PCM images, for OFFLINE ANALYSIS ONLY. Layout found by measurement on the user's dumps:
  - korgm1p1/ic40..ic43 (512 KB each): signed 8 bit samples, the high bytes of 16 bit samples (ic36..ic39 hold the
    low bytes, which carry no information that the analysis needs);
  - korgm1p1/u201..u204 (1 MB each, the Plus-1 expansion ROM): 16 bit little-endian signed samples.
The instrument's sample rate is not documented in these dumps: 44 100 Hz is ASSUMED, which only scales the time
constants and absolute frequencies of the fits (ratios between partials are unaffected)."""
import numpy as np, os

RATE = 44100


def load_m1(folder):
    out = {}
    for n in range(40, 44):
        p = os.path.join(folder, 'korgm1p1', f'ic{n}.bin')
        if os.path.exists(p):
            out[f'ic{n}'] = np.fromfile(p, dtype=np.int8).astype(np.float32) / 128.0
    for n in range(201, 205):
        p = os.path.join(folder, 'korgm1p1', f'u{n}.bin')
        if os.path.exists(p):
            out[f'u{n}'] = np.fromfile(p, dtype='<i2').astype(np.float32) / 32768.0
    return out

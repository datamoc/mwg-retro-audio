"""Distance between a recorded attack and a recipe render: mean absolute log-mel difference (dB) over the first
250 ms, both signals at equal RMS. Smaller is closer; 0 is identical on this measure (it ignores phase)."""
import numpy as np

import os

RATE = int(os.environ.get("MW_RATE", "32000"))
BANDS = 24
WIN, HOP = 512, 256
_edges = np.geomspace(100, 15000, BANDS + 1)


def logmel(x, seconds=0.25):
    n = int(seconds * RATE)
    x = np.asarray(x[:n], dtype=np.float64)
    if len(x) < n:
        x = np.concatenate([x, np.zeros(n - len(x))])
    x = x / (np.sqrt((x**2).mean()) + 1e-12)
    w = np.hanning(WIN)
    fr = np.array([x[i : i + WIN] * w for i in range(0, n - WIN + 1, HOP)])
    p = np.abs(np.fft.rfft(fr, axis=1)) ** 2
    f = np.fft.rfftfreq(WIN, 1 / RATE)
    m = np.stack([p[:, (f >= lo) & (f < hi)].sum(1) for lo, hi in zip(_edges[:-1], _edges[1:])], axis=1)
    return 10 * np.log10(m + 1e-3 * m.max())


def distance(ref, test):
    a, b = logmel(ref), logmel(test)
    return float(np.abs(a - b).mean())

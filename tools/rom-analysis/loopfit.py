"""Steady-state spectra of looped waves: harmonic amplitude profile (16 harmonics) of periodic frames, clustered into a bank.
OFFLINE ANALYSIS: the output is a few averaged numbers per cluster, never samples."""
import numpy as np
from scipy.cluster.vq import kmeans2

HARM = 16
FRAME = 4096


def frame_profile(fr, rate):
    fr = fr.astype(np.float64) - fr.mean()
    e = (fr**2).sum()
    if e < 1e-6 * len(fr):
        return None
    n = 1 << (2 * len(fr) - 1).bit_length()
    f = np.fft.rfft(fr, n)
    ac = np.fft.irfft(f * np.conj(f))[: len(fr)] / e
    l0, l1 = int(rate / 1500), int(rate / 60)
    l = l0 + int(np.argmax(ac[l0:l1]))
    r = ac[l]
    if r < 0.9:
        return None
    if 1 < l < len(ac) - 1:
        a, b, c = ac[l - 1], ac[l], ac[l + 1]
        l = l + (a - c) / (2 * (a - 2 * b + c) + 1e-12)
    f0 = rate / l
    w = np.hanning(len(fr))
    spec = np.abs(np.fft.rfft(fr * w, 1 << 15))
    fr_ax = np.fft.rfftfreq(1 << 15, 1 / rate)
    amps = []
    for k in range(1, HARM + 1):
        fk = k * f0
        if fk > 0.45 * rate:
            amps.append(0.0)
            continue
        m = (fr_ax > fk * 0.985) & (fr_ax < fk * 1.015)
        amps.append(float(spec[m].max()) if m.any() else 0.0)
    amps = np.array(amps)
    if amps[0] < 0.02 * amps.max():  # missing fundamental: the f0 estimate is probably an octave off
        return None
    return f0, float(r), amps / (amps.max() + 1e-12)


def collect(chips, rate):
    rows = []
    for name, x in chips.items():
        for i in range(0, len(x) - FRAME, FRAME):
            p = frame_profile(x[i : i + FRAME], rate)
            if p:
                rows.append((name, i, *p))
    return rows


def cluster_profiles(rows, k, seed=0):
    A = np.array([r[4] for r in rows])
    L = 20 * np.log10(np.maximum(A, 0.01))  # dB, floored at -40
    best = None
    for s in range(10):
        c, lab = kmeans2(L, k, seed=seed + s, minit='++')
        inertia = ((L - c[lab]) ** 2).sum()
        if best is None or inertia < best[0]:
            best = (inertia, c, lab)
    _, c, lab = best
    out = []
    for j in range(k):
        idx = np.where(lab == j)[0]
        if len(idx) == 0:
            continue
        prof = np.mean(A[idx], axis=0)
        out.append({'members': int(len(idx)), 'harmonics': [round(float(v) / prof.max(), 3) for v in prof]})
    out.sort(key=lambda d: -sum(h * i for i, h in enumerate(d['harmonics'])) / (sum(d['harmonics']) + 1e-9))
    return out, lab

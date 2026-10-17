"""Fit the parametric attack recipes of `D50_ATTACKS` (partials [ratio, amplitude, decay] + a noise burst) to a recorded
attack. OFFLINE ANALYSIS: only a handful of numbers per attack come out, never samples."""
import numpy as np
from scipy.signal import find_peaks

N_PARTIALS = 6


def onsets(x, hop=64, thr=18, step=8):
    """sample positions where the level rises sharply (start of an attack)"""
    env = np.sqrt((x[: len(x) // hop * hop].reshape(-1, hop).astype(np.float64) ** 2).mean(1)) + 1.0
    db = 20 * np.log10(env)
    out = []
    for i in range(8, len(db) - 2):
        if db[i + 1] - db[max(0, i - 8) : i + 1].min() >= thr and db[i + 1] - db[i] >= step:
            if not out or (i - out[-1]) * hop > 1024:
                out.append(i + 1)
    return [o * hop for o in out]


def segments(x, max_len=16384, min_len=1024, thr=18, step=8):
    on = onsets(x, thr=thr, step=step)
    segs = []
    for k, a in enumerate(on):
        b = min(on[k + 1] if k + 1 < len(on) else len(x), a + max_len)
        if b - a >= min_len:
            segs.append((a, b))
    return segs


def estimate_f0(x, rate, lo=60.0, hi=800.0):
    seg = x[: min(len(x), 4096)].astype(np.float64)
    seg = seg - seg.mean()
    n = 1 << (2 * len(seg) - 1).bit_length()
    f = np.fft.rfft(seg, n)
    ac = np.fft.irfft(f * np.conj(f))[: len(seg)]
    ac /= ac[0] + 1e-12
    l0, l1 = int(rate / hi), min(int(rate / lo), len(seg) - 1)
    l = l0 + int(np.argmax(ac[l0:l1]))
    # parabolic refinement
    if 1 < l < len(ac) - 1:
        a, b, c = ac[l - 1], ac[l], ac[l + 1]
        d = float(np.clip((a - c) / (2 * (a - 2 * b + c) + 1e-12), -1.0, 1.0))
        return rate / (l + d), float(ac[l])
    return rate / l, float(ac[l])


def stft(x, win=1024, hop=256):
    w = np.hanning(win)
    frames = [x[i : i + win] * w for i in range(0, len(x) - win + 1, hop)]
    return np.abs(np.fft.rfft(np.array(frames), axis=1)), w


def decay_of(track, hop_s, floor=0.03):
    """decay constant (s) of an amplitude track from its peak, by least squares on ln(amplitude)"""
    i0 = int(np.argmax(track))
    t = track[i0:]
    keep = t > t[0] * floor
    n = int(np.argmin(keep)) if not keep.all() else len(t)
    if n < 3:
        return 0.02
    y = np.log(t[:n] + 1e-9)
    xs = np.arange(n) * hop_s
    slope = np.polyfit(xs, y, 1)[0]
    return float(np.clip(-1.0 / slope, 0.01, 3.0)) if slope < -1e-3 else 3.0


def fit_attack(x, rate):
    """returns a dict with harmonics, noise, noiseDecay, duration, f0 and a tonal measure"""
    x = x.astype(np.float64)
    pk = int(np.argmax(np.abs(x[: len(x)])))
    x = x[max(0, pk - 128) :]
    if len(x) < 2048:
        x = np.concatenate([x, np.zeros(2048 - len(x))])
    f0, r = estimate_f0(x[128:], rate)
    spec, w = stft(x)
    hop_s = 256 / rate
    fr = np.fft.rfftfreq(1024, 1 / rate)
    scale = 2.0 / w.sum()
    first = spec[: min(3, len(spec))].mean(0)
    # partials: strongest spectral peaks, as ratios to f0
    pks, props = find_peaks(first, prominence=first.max() * 0.03)
    cand = [(first[p], fr[p]) for p in pks if fr[p] < 0.45 * rate and fr[p] > 0.6 * f0]
    cand.sort(reverse=True)
    partials = []
    for m, f in cand:
        ratio = f / f0
        if not 0.5 <= ratio <= 40:
            continue
        nearest = round(ratio)
        if nearest >= 1 and abs(ratio - nearest) < 0.06:
            ratio = float(nearest)
        if any(abs(ratio - q[0]) < 0.35 for q in partials):
            continue
        b = int(round(f / (rate / 1024)))
        track = spec[:, max(0, b - 2) : b + 3].max(1) * scale
        partials.append((float(ratio), float(track[:3].max()), decay_of(track, hop_s)))
        if len(partials) == N_PARTIALS:
            break
    if r < 0.3 or not partials:  # no usable pitch: a noise attack
        partials = partials[:2]
    amax = max([p[1] for p in partials], default=1e-9)
    # noise: mean power of the bins away from partials, in the first frames, and its decay
    mask = np.ones(len(fr), bool)
    for ratio, _, _ in partials:
        b = int(round(ratio * f0 / (rate / 1024)))
        mask[max(0, b - 4) : b + 5] = False
    mask &= fr > 0.5 * f0
    pw = (spec[:, mask] ** 2).mean(1) / (w**2).sum()
    sigma = np.sqrt(pw)
    noise_amp = float(np.sqrt(3.0) * sigma[:3].max())
    noise_decay = decay_of(sigma, hop_s, floor=0.1)
    tail = np.abs(x)
    ends = np.where(np.sqrt(np.convolve(tail**2, np.ones(256) / 256, "same")) > tail.max() * 0.02)[0]
    duration = float(min(1.5, max(0.3, (ends[-1] if len(ends) else len(x)) / rate)))
    ref = max(amax, noise_amp, 1e-9)
    return {
        "f0": float(f0),
        "tonal": float(r),
        "harmonics": [[round(p[0], 3), round(p[1] / ref, 3), round(p[2], 3)] for p in partials],
        "noise": round(noise_amp / ref, 3),
        "noiseDecay": round(noise_decay, 3),
        "duration": round(duration, 2),
    }

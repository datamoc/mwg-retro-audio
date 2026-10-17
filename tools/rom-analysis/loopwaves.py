"""Descriptors of the looped region of the LA32 PCM ROM (the waves after the 47 attacks), in ROM order.
Each frame of the region gives either a harmonic profile (16 relative amplitudes, periodic frame) or None (noise-like
frame, to be played as filtered noise). OFFLINE ANALYSIS: a few averaged numbers per frame, never samples."""
import numpy as np
from loopfit import frame_profile, HARM

FRAME = 1024


def region_frames(x, start, rate, hop=512, r_min=0.7):
    out = []
    for i in range(start, len(x) - FRAME, hop):
        fr = x[i : i + FRAME]
        p = frame_profile_r(fr, rate, r_min)
        out.append({'at': i, 'harmonics': p})
    return out


def frame_profile_r(fr, rate, r_min):
    import loopfit
    fr = fr.astype(np.float64) - fr.mean()
    e = (fr**2).sum()
    if e < 1e-6 * len(fr):
        return None
    n = 1 << (2 * len(fr) - 1).bit_length()
    f = np.fft.rfft(fr, n)
    ac = np.fft.irfft(f * np.conj(f))[: len(fr)] / e
    l0, l1 = int(rate / 4000), int(rate / 60)
    l = l0 + int(np.argmax(ac[l0:l1]))
    if ac[l] < r_min:
        return None
    if 1 < l < len(ac) - 1:
        a, b, c = ac[l - 1], ac[l], ac[l + 1]
        l = l + float(np.clip((a - c) / (2 * (a - 2 * b + c) + 1e-12), -1, 1))
    f0 = rate / l
    w = np.hanning(len(fr))
    spec = np.abs(np.fft.rfft(fr * w, 1 << 14))
    ax = np.fft.rfftfreq(1 << 14, 1 / rate)
    amps = []
    for k in range(1, HARM + 1):
        fk = k * f0
        if fk > 0.45 * rate:
            amps.append(0.0)
            continue
        m = (ax > fk * 0.97) & (ax < fk * 1.03)
        amps.append(float(spec[m].max()) if m.any() else 0.0)
    amps = np.array(amps)
    if amps.max() <= 0:
        return None
    return [round(float(v) / amps.max(), 3) for v in amps]

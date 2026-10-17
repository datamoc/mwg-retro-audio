"""Decoder of the Roland LA32 PCM image (D-50 / MT-32 sample ROM), for OFFLINE ANALYSIS ONLY.

The ROM is only ever read from a path the user gives; nothing decoded here is written into the package.
The 512 KB image (D-50 ic30 + ic29 concatenated) is a sequence of byte pairs (s, c). The 16 bits are put back in
order with the permutation published in Munt's `Synth::loadPCMROM` (LGPL-2.1+; the permutation is a fact about the
chip, no Munt code is used): word bit (15-u) <- source bit ORDER[u], with indices 0-7 the bits of s (MSB first) and
8-15 the bits of c. The word is then a sign (bit 15) and a 15 bit logarithmic magnitude, larger = louder, 2048 steps per
octave (Munt's `pcmSampleToLogSample` / `unlog`): amplitude = 2**((mag - 32767) / 2048). Checked on this dump: the
7 bits taken from s give 16 steps per octave, and the bit taken from c (bit 6) is the 8-octave step that I first
rebuilt by continuity. Sample rate of the instrument: 32 kHz.
"""
import numpy as np

RATE = 32000
ORDER = [0, 9, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 8]


def descramble(path):
    b = np.fromfile(path, dtype=np.uint8)
    s = b[0::2].astype(np.uint32)
    c = b[1::2].astype(np.uint32)
    word = np.zeros(len(s), dtype=np.uint32)
    for u, o in enumerate(ORDER):
        bit = ((s >> (7 - o)) & 1) if o < 8 else ((c >> (7 - (o - 8))) & 1)
        word |= bit << (15 - u)
    return word


def decode_la32(path):
    word = descramble(path)
    mag = (word & 0x7FFF).astype(np.float64)
    sign = np.where(word & 0x8000, -1.0, 1.0)
    return (sign * 8192.0 * np.power(2.0, (mag - 32767.0) / 2048.0)).astype(np.float32)

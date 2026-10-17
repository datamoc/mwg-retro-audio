"""usage: run_m1_attacks.py m1_folder out_prefix  -> <prefix>.npy (all chips concatenated, for evaluate.py) and <prefix>_fits.json"""
import sys, json, numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0] if '/' in __file__ else '.')
from m1rom import load_m1, RATE
from attackfit import segments, fit_attack
chips = load_m1(sys.argv[1])
allx, fits, off = [], [], 0
for name, x in chips.items():
    for a, b in segments(x * 8192, max_len=int(0.5 * RATE), min_len=1024, thr=12, step=6):
        d = fit_attack(x[a:b] * 8192, RATE)  # same amplitude scale as the LA32 decoder (the fit is scale free)
        d.update(chip=name, start=off + a, end=off + b)
        fits.append(d)
    allx.append(x * 8192)
    off += len(x)
np.save(sys.argv[2] + '.npy', np.concatenate(allx).astype(np.float32))
json.dump(fits, open(sys.argv[2] + '_fits.json', 'w'))
print(len(fits), 'attacks;', sum(1 for d in fits if d['tonal'] > 0.3), 'tonal')

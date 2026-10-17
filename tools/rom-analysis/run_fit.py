import sys, json, numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0] if '/' in __file__ else '.')
from la32 import decode_la32, RATE
from attackfit import segments, fit_attack

rom, out = sys.argv[1], sys.argv[2]
x = decode_la32(rom)
segs = segments(x)
res = []
for a, b in segs:
    d = fit_attack(x[a:b], RATE); d['start'] = a; d['end'] = b
    res.append(d)
json.dump(res, open(out, 'w'))
print(len(res), 'attacks fitted;', sum(1 for d in res if d['tonal'] > 0.3), 'tonal')
for d in res[:6]: print(d)

import sys, json, numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0] if '/' in __file__ else '.')
from m1rom import load_m1, RATE
from loopfit import collect, cluster_profiles
chips = load_m1(sys.argv[1])
rows = collect(chips, RATE)
print(len(rows), 'periodic frames of', sum(len(x) // 4096 for x in chips.values()))
json.dump([[r[0], r[1], r[2], r[3], list(map(float, r[4]))] for r in rows], open(sys.argv[2], 'w'))

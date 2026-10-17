"""usage: emit_ts.py bank.json  ->  the `D50_ATTACKS` array body for src/chips/historical.ts"""
import sys, json
bank = json.load(open(sys.argv[1]))
fmt = lambda v: ('%g' % v)
out = []
for b in bank:
    hs = ', '.join('[%s, %s, %s]' % (fmt(r), fmt(a), fmt(d)) for r, a, d in b['harmonics'])
    out.append("\tatk(%s, [%s], %s, %s, %s)," % (json.dumps(b['name']).replace('"', "'"), hs, fmt(b['noise']), fmt(b['noiseDecay']), fmt(b['duration'])))
print('\n'.join(out))

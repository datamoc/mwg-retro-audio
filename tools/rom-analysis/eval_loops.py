"""usage: eval_loops.py frames.json K   -> train on ic* frames, test on u20* frames; also the final bank from all frames"""
import sys, json, numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0] if '/' in __file__ else '.')
from loopfit import cluster_profiles, HARM

rows = [(r[0], r[1], r[2], r[3], np.array(r[4])) for r in json.load(open(sys.argv[1]))]
K = int(sys.argv[2])
db = lambda a: 20 * np.log10(np.maximum(a, 0.01))
dist = lambda a, b: float(np.abs(db(a) - db(b)).mean())
k = np.arange(1, HARM + 1)
classic = {'saw': 1 / k, 'square': np.where(k % 2, 1 / k, 0), 'triangle': np.where(k % 2, 1 / k**2, 0), 'sine': np.where(k == 1, 1.0, 0)}
classic = {n: v / v.max() for n, v in classic.items()}
train = [r for r in rows if r[0].startswith('ic')]
test = [r for r in rows if r[0].startswith('u')]
print(len(train), 'train frames (ic*),', len(test), 'test frames (u*)')
bank, _ = cluster_profiles(train, K)
B = [np.array(b['harmonics']) for b in bank]
res_b = [min(dist(r[4], b) for b in B) for r in test]
res_c = [min(dist(r[4], c) for c in classic.values()) for r in test]
print(f'held-out frames: nearest of {len(B)} fitted spectra {np.mean(res_b):.2f} dB; nearest classic wave (saw/square/triangle/sine) {np.mean(res_c):.2f} dB')
final, _ = cluster_profiles(rows, K)
json.dump(final, open(sys.argv[1].replace('.json', '_bank.json'), 'w'), indent=1)
print('final bank', len(final), [b['members'] for b in final])

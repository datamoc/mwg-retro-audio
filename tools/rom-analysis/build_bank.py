"""Cluster the fitted attacks into a bank of N recipes (medoids), keeping the role names of an existing bank.
usage: build_bank.py fits.json old_bank.json out_bank.json [--train even|all]"""
import sys, json, numpy as np
from scipy.cluster.vq import kmeans2
from scipy.optimize import linear_sum_assignment


def features(d):
    h = d['harmonics']
    amps = np.zeros(6)
    for ratio, a, _ in h:
        k = int(round(ratio)) - 1
        if 0 <= k < 6:
            amps[k] = max(amps[k], a)
    tot = sum(a for _, a, _ in h) + 1e-9
    centroid = sum(r * a for r, a, _ in h) / tot
    main_decay = max(h, key=lambda p: p[1])[2] if h else 0.05
    return np.concatenate([[np.log2(max(centroid, 1.0)), np.log2(main_decay), d['noise'], np.log2(max(d['noiseDecay'], 1e-3)), np.log2(d['duration'])], amps])


def main():
    fits = json.load(open(sys.argv[1]))
    old = json.load(open(sys.argv[2]))
    mode = sys.argv[sys.argv.index('--train') + 1] if '--train' in sys.argv else 'even'
    if mode == 'even':
        train = fits[::2]
    elif mode == 'all':
        train = fits
    else:  # a chip-name prefix: train on the attacks of those chips only
        train = [d for d in fits if d.get('chip', '').startswith(mode)]
    k = len(old)
    X = np.array([features(d) for d in train])
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = (X - mu) / sd
    best = None
    for seed in range(20):
        c, lab = kmeans2(Z, min(k, len(Z)), seed=seed, minit='++')
        inertia = ((Z - c[lab]) ** 2).sum()
        if best is None or inertia < best[0]:
            best = (inertia, c, lab)
    _, c, lab = best
    medoids = []
    for j in range(len(c)):
        idx = np.where(lab == j)[0]
        if len(idx) == 0:
            continue
        medoids.append(idx[np.argmin(((Z[idx] - c[j]) ** 2).sum(1))])
    # if there are fewer clusters than roles, the remaining roles keep their old recipe
    new = [train[i] for i in medoids]
    O = (np.array([features(o) for o in old]) - mu) / sd
    N = (np.array([features(n) for n in new]) - mu) / sd
    cost = ((O[:, None, :] - N[None, :, :]) ** 2).sum(2)
    ri, ci = linear_sum_assignment(cost)
    bank = [dict(o) for o in old]
    for r, cidx in zip(ri, ci):
        n = new[cidx]
        bank[r] = {'name': old[r]['name'], 'harmonics': n['harmonics'], 'noise': n['noise'], 'noiseDecay': n['noiseDecay'], 'duration': n['duration']}
    json.dump(bank, open(sys.argv[3], 'w'), indent=1)
    print('bank of', len(bank), 'recipes from', len(train), 'attacks;', len(ri), 'roles refitted')


if __name__ == '__main__':
    main()

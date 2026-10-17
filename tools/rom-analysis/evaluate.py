"""usage: evaluate.py rom fits.json bank.json [--test odd|all]
For every reference attack, the best recipe of the bank (rendered at the attack's own pitch) and its distance."""
import sys, os, json, subprocess, tempfile, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from la32 import decode_la32, RATE
from closeness import distance

def evaluate(rom, fits_path, bank_path, test='odd'):
    x = np.load(rom) if rom.endswith('.npy') else decode_la32(rom)
    fits = json.load(open(fits_path))
    if test == 'odd':
        sel = list(range(1, len(fits), 2))
    elif test == 'all':
        sel = list(range(len(fits)))
    else:  # a chip-name prefix: test on the attacks of those chips only
        sel = [i for i, d in enumerate(fits) if d.get('chip', '').startswith(test)]
    d = tempfile.mkdtemp(prefix='bank-')
    f0p, binp, idxp = (os.path.join(d, n) for n in ('f0.json', 'r.bin', 'r.json'))
    json.dump([fits[i]['f0'] for i in sel], open(f0p, 'w'))
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    subprocess.run(['node', '--import', 'tsx', os.path.join(root, 'tools/rom-analysis/render-bank.ts'), bank_path, f0p, binp, idxp], check=True, cwd=root)
    audio = np.fromfile(binp, dtype=np.float32)
    idx = json.load(open(idxp))
    per = {}
    for e in idx:
        f = fits[sel[e['seg']]]
        ref = x[f['start'] : f['end']]
        pk = int(np.argmax(np.abs(ref))); ref = ref[max(0, pk - 128):]
        w = audio[e['offset'] : e['offset'] + e['length']]
        per.setdefault(e['seg'], []).append(distance(ref, w))
    best = [min(v) for v in per.values()]
    return float(np.mean(best)), float(np.median(best)), len(best)

if __name__ == '__main__':
    test = sys.argv[sys.argv.index('--test') + 1] if '--test' in sys.argv else 'odd'
    m, med, n = evaluate(sys.argv[1], sys.argv[2], sys.argv[3], test)
    print(f'{n} reference attacks: mean best-recipe distance {m:.2f} dB (median {med:.2f})')

import trimesh, numpy as np, sys
NS, IT = 8000, 30
from scipy.spatial import cKDTree
exec(open('scripts/compare.py').read().split('def stats')[0])
def talign(am, pm, t=None):
    A = am.sample(NS); P = pm.sample(NS); ta = cKDTree(A)
    if t is None: t = am.bounds.mean(0) - pm.bounds.mean(0)
    for i in range(IT):
        d, idx = ta.query(P + t)
        keep = d < np.percentile(d, 60)
        t = t + np.median((A[idx] - (P + t))[keep], axis=0)
    d, _ = ta.query(P + t)
    return t, np.percentile(d*1000, [50, 80, 95])
if __name__ == '__main__':
    o, f = sys.argv[1], sys.argv[2]
    am = mesh_rel(asm, o); pm = mesh_rel(trimesh.load(f), None)
    for start in [None, np.zeros(3)]:
        t, p = talign(am, pm, start); print('t mm', (t*1000).round(2), 'dist', p.round(3))

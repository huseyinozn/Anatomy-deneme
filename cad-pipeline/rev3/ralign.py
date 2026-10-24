import trimesh, numpy as np, sys, itertools
from scipy.spatial import cKDTree
exec(open('scripts/talign.py').read().split("if __name__")[0])
o, f = sys.argv[1], sys.argv[2]
am = mesh_rel(asm, o); pm0 = mesh_rel(trimesh.load(f), None)
res = []
for perm in itertools.permutations(range(3)):
    for sg in itertools.product([1, -1], repeat=3):
        R = np.zeros((3, 3))
        for i in range(3): R[i, perm[i]] = sg[i]
        if np.linalg.det(R) < 0: continue
        if not np.allclose(np.sort(np.abs(R @ (pm0.bounds[1]-pm0.bounds[0]))), np.sort(am.bounds[1]-am.bounds[0]), atol=0.006): continue
        M = np.eye(4); M[:3, :3] = R; pm = pm0.copy(); pm.apply_transform(M)
        t, p = talign(am, pm); res.append((p[0], perm, sg, (t*1000).round(2), p.round(3)))
for r in sorted(res, key=lambda r: r[0])[:4]: print(r[1:])

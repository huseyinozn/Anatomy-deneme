import trimesh, numpy as np, sys, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
exec(open('scripts/compare.py').read().split('def stats')[0])
o, f, out = sys.argv[1], sys.argv[2], sys.argv[3]
t = np.array([float(x) for x in sys.argv[4].split(',')])/1000 if len(sys.argv) > 4 else np.zeros(3)
am = mesh_rel(asm, o); pm = mesh_rel(trimesh.load(f), None)
if len(sys.argv) > 5:
    S = np.diag([float(x) for x in sys.argv[5].split(",")] + [1]); pm.apply_transform(S)
pm.apply_translation(t)
A = am.sample(40000); P = pm.sample(40000)
fig, ax = plt.subplots(1, 3, figsize=(18, 6))
for k, (i, j) in enumerate([(0, 1), (0, 2), (2, 1)]):
    ax[k].scatter(A[:, i]*1000, A[:, j]*1000, s=0.2, c='red', alpha=.5, label='montaj (eski)')
    ax[k].scatter(P[:, i]*1000, P[:, j]*1000, s=0.2, c='blue', alpha=.3, label='yeni parça')
    ax[k].set_aspect('equal'); ax[k].set_title('xyz'[i]+'-'+'xyz'[j])
ax[0].legend(markerscale=20); fig.suptitle(f'{o} vs {f}'); fig.tight_layout(); fig.savefig(out, dpi=80)

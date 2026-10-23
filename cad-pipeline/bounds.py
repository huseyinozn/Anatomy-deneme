import trimesh, numpy as np, json, sys
s = trimesh.load(sys.argv[1])
g = s.graph
children = {}
for a, b, *_ in g.to_edgelist():
    children.setdefault(a, []).append(b)
def leaves(n):
    out, st = [], [n]
    while st:
        x = st.pop()
        if x in children: st.extend(children[x])
        else: out.append(x)
    return out
def bbox(n):
    pts = []
    for leaf in leaves(n):
        T, geom = g[leaf]
        if geom is None: continue
        m = s.geometry[geom]
        pts.append(trimesh.transform_points(m.bounds, T))
        b = trimesh.transform_points(trimesh.bounds.corners(m.bounds), T); pts.append(b)
    if not pts: return None
    p = np.vstack(pts); return p.min(0), p.max(0)
names = json.load(open(sys.argv[2]))
for n in sys.argv[3:]:
    b = bbox(n)
    if b is None: print(n, "empty"); continue
    lo, hi = (b[0]*1000).round(0), (b[1]*1000).round(0)
    print(f"{n:8s} {names.get(n,{}).get('child','')[:45]:45s} lo={lo.tolist()} hi={hi.tolist()}")

import trimesh, numpy as np, json, sys, glob, os, re
asm = trimesh.load('asm.glb'); g = asm.graph
names = json.load(open('names.json'))
kids = {}
for a, b, *_ in g.to_edgelist(): kids.setdefault(a, []).append(b)
def leaves(n):
    out, st = [], [n]
    while st:
        x = st.pop()
        if x in kids: st.extend(kids[x])
        else: out.append(x)
    return out
def mesh_rel(scene, root):
    gg = scene.graph; Tr = np.linalg.inv(gg.get(root)[0]) if root else np.eye(4)
    ms = []
    for leaf in (leaves(root) if root else gg.nodes_geometry):
        T, geom = gg.get(leaf)
        if geom is None: continue
        m = scene.geometry[geom].copy(); m.apply_transform(Tr @ T); ms.append(m)
    return trimesh.util.concatenate(ms) if ms else None
def stats(m):
    return dict(lo=(m.bounds[0]*1000), hi=(m.bounds[1]*1000), vol=abs(m.volume)*1e9, area=m.area*1e6)
def norm(s): return s.replace('_X2_0131_X0_', 'i').replace('ı', 'i')
res = []
for f in sorted(glob.glob('pglb/*.glb')):
    pn = os.path.basename(f)[:-4]
    ps = trimesh.load(f)
    pm = mesh_rel(ps, None)
    # part scene root: apply world T of its first geometry node relative to scene root
    p = stats(pm)
    base = re.sub(r'-(\d\d-\d\d)$', '', pn)
    occ = [k for k, v in names.items() if v['child'] and norm(v['child']) == base]
    line = f"{pn:36s} occ={len(occ):2d} vol={p['vol']:9.0f} ext={np.round(p['hi']-p['lo'],1).tolist()}"
    for o in occ[:1]:
        am = mesh_rel(asm, o)
        if am is None: line += f" | {o} EMPTY"; continue
        a = stats(am)
        dlo = np.abs(a['lo']-p['lo']).max(); dhi = np.abs(a['hi']-p['hi']).max()
        line += f" | {o} vol={a['vol']:9.0f} dV={100*(p['vol']-a['vol'])/max(a['vol'],1):+6.2f}% dBox={max(dlo,dhi):6.2f}mm"
    print(line, flush=True)

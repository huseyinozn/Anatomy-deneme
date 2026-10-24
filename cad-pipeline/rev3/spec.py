import json, glob, os, re
names = json.load(open('names.json'))
norm = lambda s: s.replace('_X2_0131_X0_', 'i').replace('ı', 'i')
parts = {}
for f in sorted(glob.glob('pglb/*.glb')):
    pn = os.path.basename(f)[:-4]; base = re.sub(r'-(\d\d-\d\d)$', '', pn)
    if base not in parts or pn != base: parts[base] = os.path.abspath(f)  # dated revision wins
# y-inject-4 was re-drawn rotated 180 deg about Z with a new origin (found by alignment)
FIX = {'Quadro-y-inject-plastic-4': [-1,0,0,0, 0,-1,0,0, 0,0,1,0, 0.45253,0.22216,1.46864,1]}
spec = []
for k, v in names.items():
    b = norm(v['child'] or '')
    if b in parts:
        e = {'occ': k, 'file': parts[b]}
        if b in FIX: e['matrix'] = FIX[b]
        spec.append(e)
json.dump(spec, open('spec.json', 'w'), indent=1)
print(len(spec), 'occurrences;', len(parts), 'parts;', 'unused:', [p for p in parts if not any(norm(v['child'] or '') == p for v in names.values())])

#!/usr/bin/env python3
"""Resolve an OrcaSlicer system preset into one flat JSON the CLI can load: follow "inherits" up the chain inside the
vendor's folder (and OrcaFilamentLibrary for filaments), parent values first, child values on top.
usage: flatten.py <profiles dir> <vendor> <machine|process|filament> <preset name> <out.json>"""
import json, pathlib, sys

root, vendor, kind, name, out = pathlib.Path(sys.argv[1]), *sys.argv[2:6]
index = {}
for v in [vendor, "OrcaFilamentLibrary"]:
    for f in (root / v).rglob("*.json"):
        try: d = json.loads(f.read_text(encoding="utf-8-sig"))
        except Exception: continue
        if isinstance(d, dict) and "name" in d: index.setdefault(d["name"], d)

def resolve(n, seen=()):
    if n not in index: raise SystemExit("preset not found: " + n)
    d = index[n]
    base = resolve(d["inherits"], seen + (n,)) if d.get("inherits") else {}
    merged = {**base, **d}
    merged.pop("inherits", None)
    return merged

d = resolve(name)
d["name"] = name; d["from"] = "system"; d["type"] = kind; d.setdefault("version", "2.4.0.0")
pathlib.Path(out).write_text(json.dumps(d, indent=1))
print(out, len(d), "keys")

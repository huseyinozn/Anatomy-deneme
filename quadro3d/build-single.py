#!/usr/bin/env python3
"""Build one self-contained quadro-3d.html: the page, the model, the images and three.js inlined, so the
file opens on its own (double-click, e-mail or chat attachment) with no server and no network.

usage: build-single.py <three.js vendor dir with build/ and examples/jsm/> <output.html>
"""
import base64, json, pathlib, re, sys

here = pathlib.Path(__file__).parent
vendor, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
page = (here / "index.html").read_text()
b64 = lambda p: base64.b64encode(p.read_bytes()).decode()
module = lambda src: "data:text/javascript;base64," + base64.b64encode(src.encode()).decode()

def replace_once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)

page = replace_once(page, 'const MODEL_URL = "quadro-glb.txt";', 'const MODEL_URL = "data:model/gltf-binary;base64,' + b64(here / "quadro.glb") + '";')
page = replace_once(page, 'const CONFIG_URL = "printer-config.json";', 'const CONFIG_URL = "data:application/json;base64,' + b64(here / "printer-config.json") + '";')
page = replace_once(page, 'fetch("logo.svg")', 'fetch("data:image/svg+xml;base64,' + b64(here / "logo.svg") + '")')
page = replace_once(page, 'load("screen.png"', 'load("data:image/png;base64,' + b64(here / "screen.png") + '"')

# three.js and the addons as data: modules; relative imports inside addons become bare specifiers the import map resolves
addons = ["controls/OrbitControls.js", "loaders/GLTFLoader.js", "environments/RoomEnvironment.js", "utils/BufferGeometryUtils.js"]
imports = {"three": module((vendor / "build/three.module.js").read_text())}
for a in addons:
    src = (vendor / "examples/jsm" / a).read_text().replace("'../utils/BufferGeometryUtils.js'", "'three/addons/utils/BufferGeometryUtils.js'")
    imports["three/addons/" + a] = module(src)
imports["quadro/jinja"] = module((here / "jinja.js").read_text())
imports["quadro/klipper"] = module((here / "klipper.js").read_text())
page, n = re.subn(r'<script type="importmap">.*?</script>', lambda m: '<script type="importmap">' + json.dumps({"imports": imports}) + "</script>", page, flags=re.S)
assert n == 1

head = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Interactive 3D simulation of the Co Print Quadro four-toolhead 3D printer and its toolchanges.">
<style>body{margin:0}</style>
</head><body>
"""
out.write_text(head + page + "\n</body></html>\n")
print(out, round(out.stat().st_size / 1e6, 1), "MB")

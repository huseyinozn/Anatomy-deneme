#!/bin/sh
# Build a standalone copy of the page for GitHub Pages into $1 (default: dist/):
# a full HTML document around the page, the model served as plain .glb, and the images.
set -e
cd "$(dirname "$0")"
OUT=${1:-dist}
mkdir -p "$OUT"
{
  printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  printf '<meta name="description" content="Interactive 3D simulation of the Co Print Quadro four-toolhead 3D printer and its toolchanges.">\n'
  printf '<meta property="og:title" content="Co Print Quadro 3D">\n'
  printf '<meta property="og:description" content="Four independent toolheads, one X beam, synchronized toolchanges. Explore the Quadro in 3D.">\n'
  printf '<link rel="icon" href="logo.svg">\n'
  printf '<style>body{margin:0}</style>\n</head><body>\n'
  sed 's|^const MODEL_URL = "quadro-glb.txt";|const MODEL_URL = "quadro.glb";|' index.html
  printf '\n</body></html>\n'
} > "$OUT/index.html"
grep -q 'MODEL_URL = "quadro.glb"' "$OUT/index.html"
cp quadro.glb screen.png logo.svg klipper.js jinja.js printer-config.json "$OUT/"
cp ask-worker/ask-config.json "$OUT/"   # settings the Ask worker re-reads (prompt, model, limits)
touch "$OUT/.nojekyll"
echo "built $OUT"

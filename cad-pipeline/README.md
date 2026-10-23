# Quadro CAD → web pipeline

1. `names.py <step> <names.json>`: maps STEP assembly occurrences (NAUO ids) to part names.
2. Convert STEP to GLB with `cascadio.step_to_glb(step, glb, 0.3, 0.6)` (pip install cascadio).
3. `node pack.mjs <in.glb> <out.glb> 0.12 0.002 <names.json> no`: drops misplaced copies and the extra heads, names every node `NAUO:part`, simplifies and quantizes.
4. `base64 -w0 out.glb > quadro3d/quadro-glb.txt` (artifacts serve text, not .glb).

The CAD-derived model files are kept out of git on purpose.

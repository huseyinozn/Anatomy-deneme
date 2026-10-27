#!/usr/bin/env python3
"""Turn an OrcaSlicer G-code for the Quadro into the compact toolpath the page's 3D printer plays: per layer, the
extruded runs in the order they print, each with its tool and whether it is part or prime tower. A run is a chain of
extruding moves that join end to start; it is thinned with Ramer-Douglas-Peucker to TOL mm, and coordinates are kept
in tenths of a millimetre, each point stored as the step from the one before.
usage: toolpath.py plate_1.gcode out.json
out: {"v": 1, "layers": [[z, [[tool, kind (0 part, 1 tower), x0, y0, dx1, dy1, ...], ...]], ...]}"""
import json, sys

TOL = 0.08


def thin(pts):
    """Ramer-Douglas-Peucker, iterative so long perimeters do not hit the recursion limit."""
    if len(pts) < 3: return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay; n = (dx * dx + dy * dy) ** 0.5
        far, at = 0.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / n if n else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > far: far, at = d, i
        if far > TOL: keep[at] = True; stack += [(a, at), (at, b)]
    return [p for p, k in zip(pts, keep) if k]


def main(src, dst):
    layers, runs, run = [], None, None
    x = y = z = 0.0; tool = 0; tower = False; relative = True; e_abs = 0.0

    def close():
        nonlocal run
        if run and runs is not None and len(run[2]) > 1: runs.append(run)
        run = None

    with open(src, errors="replace") as f:
        for line in f:
            if line[0] == ";":
                if line.startswith(";LAYER_CHANGE"):
                    close(); runs = []; layers.append([None, runs])
                elif line.startswith(";Z:") and layers and layers[-1][0] is None:
                    layers[-1][0] = float(line[3:])
                elif line.startswith(";TYPE:"):
                    close(); tower = "tower" in line.lower()
                continue
            code = line.split(";", 1)[0].split()
            if not code: continue
            c = code[0]
            if c[0] == "T" and c[1:].isdigit():
                close(); tool = int(c[1:]); continue
            if c == "M83": relative = True; continue
            if c == "M82": relative = False; continue
            if c == "G92":
                for w in code[1:]:
                    if w[0] == "E": e_abs = float(w[1:])
                continue
            if c not in ("G0", "G1"): continue
            nx, ny, de = x, y, 0.0
            for w in code[1:]:
                k = w[0]
                if k == "X": nx = float(w[1:])
                elif k == "Y": ny = float(w[1:])
                elif k == "Z": z = float(w[1:])
                elif k == "E":
                    v = float(w[1:])
                    if relative: de = v
                    else: de, e_abs = v - e_abs, v
            moved = nx != x or ny != y
            if de > 0 and moved and runs is not None:
                kind = 1 if tower else 0
                if run and run[0] == tool and run[1] == kind and run[2][-1] == (x, y): run[2].append((nx, ny))
                else: close(); run = [tool, kind, [(x, y), (nx, ny)]]
            elif moved: close()
            x, y = nx, ny
    close()

    out, points = [], 0
    for lz, lruns in layers:
        if not lruns: continue
        enc = []
        for t, kind, pts in lruns:
            pts = thin(pts); points += len(pts)
            flat, px, py = [t, kind], 0, 0
            for i, (a, b) in enumerate(pts):
                ix, iy = round(a * 10), round(b * 10)
                flat += [ix, iy] if i == 0 else [ix - px, iy - py]
                px, py = ix, iy
            enc.append(flat)
        out.append([lz, enc])
    with open(dst, "w") as f: json.dump({"v": 1, "layers": out}, f, separators=(",", ":"))
    print(json.dumps({"layers": len(out), "points": points}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

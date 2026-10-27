#!/usr/bin/env python3
"""Summarise an OrcaSlicer G-code: print time, toolchanges and filament split into the part, the prime tower and the
flush purged out of the nozzle ("poop"). Extrusion is summed per section from the slicer's own markers:
inside a toolchange (CP TOOLCHANGE START up to WIPE) everything extruded leaves through the purge chute ("flush"),
the tower wipe after it and the "Prime tower" feature build the tower, everything else is the part. A1 retracts at
the filament cut with M620.11 E-…, which is counted so the reload after it nets to zero.
usage: stats.py plate_1.gcode [extra seconds per toolchange]  -> JSON"""
import json, re, sys

path = sys.argv[1]
extra_tc = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
mm = {"part": 0.0, "tower": 0.0, "flush": 0.0}
relative, last_e, section, flushing, changes = True, 0.0, "part", False, 0
in_change, started = False, 0
time_s, grams, lengths = None, [], []

def secs(text):
    t = 0
    for n, u in re.findall(r"(\d+)\s*([dhms])", text): t += int(n) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[u]
    return t

with open(path, errors="replace") as f:
    for line in f:
        if line.startswith(";"):
            s = line[1:].strip()
            if s.startswith("FLUSH_START"): flushing = True
            elif s.startswith("FLUSH_END"): flushing = False
            elif s.startswith("CP TOOLCHANGE START"): in_change = True; started += 1
            elif s.startswith(("CP TOOLCHANGE WIPE", "CP TOOLCHANGE END")): in_change = False
            elif s.startswith(("TYPE:", "FEATURE:")): section = "tower" if "tower" in s.lower() else "part"
            elif s.startswith("total estimated time:") or "total estimated time:" in s: time_s = secs(s.split("total estimated time:")[1])
            elif s.startswith("estimated printing time (normal mode)") and time_s is None: time_s = secs(s.split("=")[1])
            elif s.startswith("filament used [g]"): grams = [float(x) for x in s.split("=")[1].split(",")]
            elif s.startswith("filament used [mm]"): lengths = [float(x) for x in s.split("=")[1].split(",")]
            elif s.startswith("total filament change"): changes = int(s.split("=")[1])
            continue
        code = line.split(";", 1)[0].split()
        if not code: continue
        c = code[0]
        if c == "M83": relative = True
        elif c == "M82": relative = False
        elif c == "G92":
            for w in code[1:]:
                if w[0] == "E": last_e = float(w[1:])
        elif c in ("G0", "G1", "G2", "G3") or (c == "M620.11" and "S1" in code):
            for w in code[1:]:
                if w[0] == "E":
                    e = float(w[1:]); d = e if relative else e - last_e; last_e = e if not relative else last_e
                    mm["flush" if flushing or in_change else section] += d

total_mm = sum(lengths) or sum(mm.values())
g_per_mm = (sum(grams) / sum(lengths)) if grams and lengths and sum(lengths) else 1.24 * 3.14159 * 0.875 ** 2 / 1000
# the part and the tower are clearly marked, so they are counted; the flush is what the slicer's own total leaves over
# (the A1's cut-and-reload firmware commands make counting the purge itself unreliable)
total_g = round(sum(grams), 2) if grams else round(total_mm * g_per_mm, 2)
out = {"part": round(mm["part"] * g_per_mm, 2), "tower": round(mm["tower"] * g_per_mm, 2)}
out["flush"] = round(max(0.0, total_g - out["part"] - out["tower"]), 2)
changes = changes or started            # Bambu G-code has no "total filament change" line
out.update(total_g=total_g, toolchanges=changes,
           slicer_time_s=time_s, toolchange_time_s=round(changes * extra_tc), time_s=(time_s or 0) + round(changes * extra_tc))
print(json.dumps(out))

#!/usr/bin/env python3
"""Slicing service for the Quadro 3D page: one uploaded model (3MF with its colours, or STL) is sliced by OrcaSlicer's
command line for three printers at once (Bambu Lab A1 combo, Snapmaker U1, Co Print Quadro) and the page gets back the
print time, the filament in the part and the waste of each (prime tower, and the flush the A1 purges out as "poop").
The Quadro G-code is kept so the page can list it on the printer's touch screen.

POST /slice   body: the model file, header X-Filename (".3mf" or ".stl")   -> JSON results
              with "Accept: application/x-ndjson": progress as it happens, one JSON object per line
              ({"stage": ...}, {"done": printer, ...} as each printer finishes), the results last as {"result": ...}
GET  /gcode/<job id>                                                       -> the Quadro G-code
Responses are gzip-compressed when the client accepts it (Cloud Run refuses bodies over 32 MB; G-code shrinks ~3x).
GET  /health

Standard library only; runs inside the linuxserver/orcaslicer image (see Dockerfile)."""
import base64, gzip, json, os, pathlib, re, shutil, struct, subprocess, sys, tempfile, threading, time, uuid, zipfile, zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).parent
ORCA = os.environ.get("ORCA", "/opt/orcaslicer/AppRun")
SYSTEM = pathlib.Path(os.environ.get("ORCA_PROFILES", "/opt/orcaslicer/resources/profiles"))
DATA = pathlib.Path(os.environ.get("DATA", "/data"))
ORIGINS = os.environ.get("ALLOWED_ORIGINS", "https://calculator.coprint3d.com,https://huseyinozn.github.io,null").split(",")
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "60")) << 20
SLICE_TIMEOUT = int(os.environ.get("SLICE_TIMEOUT", "780"))
COLOURS = ["#2F7FE6", "#E5484D", "#2FA868", "#F2C230"]

# name shown, vendor folder, machine / process / filament presets, how filaments map to nozzles, seconds the slicer
# leaves out of each toolchange (the Quadro profile's change macro has no time of its own; 1.5 s is the parallel
# carriage move measured on the machine's planner), prime tower Y that keeps a four-colour tower on the bed
PRINTERS = {
    "a1": {"name": "Bambu Lab A1 combo", "vendor": "BBL", "machine": "Bambu Lab A1 0.4 nozzle", "process": "0.20mm Standard @BBL A1",
           "filament": "Bambu PLA Basic @BBL A1", "map": "single", "tc_extra": 0, "tower_y": 165},
    "u1": {"name": "Snapmaker U1", "vendor": "Snapmaker Orca", "machine": "Snapmaker U1 (0.4 nozzle)", "process": "0.20mm Standard @Snapmaker U1 (0.4 nozzle)",
           "filament": "Snapmaker PLA Basic @U1", "map": "tool", "tc_extra": 0, "tower_y": None,
           # its start G-code reads a setting only Snapmaker's build has; 1 picks the default chamber cooling branch
           "gcode_vars": {"chamber_cooling_mode": "1"}},
    "quadro": {"name": "Co Print Quadro", "vendor": "Co Print", "machine": "Co Print Quadro 0.4 nozzle", "process": "0.2mm Standard @CP Quadro",
               "filament": "Co Print PLA (Quadro)", "map": "tool", "tc_extra": 1.5, "tower_y": None},
}


def orca(args, cwd, log):
    with open(log, "w") as f:
        return subprocess.run([ORCA, *args], cwd=cwd, stdout=f, stderr=subprocess.STDOUT, timeout=SLICE_TIMEOUT,
                              env={**os.environ, "HOME": str(DATA / "home")}).returncode


def run_py(script, *args):
    return subprocess.run([sys.executable, "-I", str(HERE / script), *map(str, args)], capture_output=True, text=True, check=True).stdout


def cube_stl(path):
    v = [(x, y, z) for x in (0, 20) for y in (0, 20) for z in (0, 20)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    tris = [t for a, b, c, d in faces for t in ((a, b, c), (a, c, d))]
    with open(path, "wb") as f:
        f.write(b"\0" * 80 + struct.pack("<I", len(tris)))
        for t in tris: f.write(struct.pack("<3f", 0, 0, 0) + b"".join(struct.pack("<3f", *v[i]) for i in t) + b"\0\0")


def prepare():
    """Flatten the presets, write one filament file per slot (distinct names, or OrcaSlicer treats four identical
    filaments as one and drops the prime tower) and export a complete project-settings template per printer and
    colour count."""
    profiles = DATA / "profiles"
    if not profiles.exists():
        shutil.copytree(SYSTEM, profiles)
        shutil.copytree(HERE / "profiles" / "Co Print", profiles / "Co Print", dirs_exist_ok=True)
        # the U1 presets of Snapmaker's own OrcaSlicer build (github.com/Snapmaker/OrcaSlicer), which purge more on the
        # tower than the older U1 presets bundled with OrcaSlicer
        shutil.copytree(HERE / "profiles" / "Snapmaker Orca", profiles / "Snapmaker Orca", dirs_exist_ok=True)
        shutil.copy(HERE / "profiles" / "Co Print.json", profiles / "Co Print.json")
    (DATA / "home" / ".config" / "OrcaSlicer").mkdir(parents=True, exist_ok=True)
    flat, tpl = DATA / "flat", DATA / "tpl"; flat.mkdir(exist_ok=True); tpl.mkdir(exist_ok=True)
    cube = DATA / "cube.stl"; cube_stl(cube)
    for tag, p in PRINTERS.items():
        for kind in ("machine", "process", "filament"):
            out = flat / f"{tag}_{kind}.json"
            if not out.exists():
                run_py("flatten.py", profiles, p["vendor"], kind, p[kind], out)
                if kind == "machine" and p.get("gcode_vars"):
                    m = json.loads(out.read_text())
                    for var, value in p["gcode_vars"].items():
                        m["machine_start_gcode"] = re.sub(r"\b%s\b" % var, value, m["machine_start_gcode"])
                    out.write_text(json.dumps(m, indent=1))
        base = json.loads((flat / f"{tag}_filament.json").read_text())
        for i, c in enumerate(COLOURS, 1):
            g = dict(base, filament_colour=[c], name=f"{base['name']} #{i}"); g["filament_settings_id"] = [g["name"]]
            (flat / f"{tag}_f{i}.json").write_text(json.dumps(g))
        for n in range(1, 5):
            out = tpl / f"{tag}_{n}.json"
            if out.exists(): continue
            work = pathlib.Path(tempfile.mkdtemp(dir=DATA))
            code = orca(["--load-settings", f"{flat}/{tag}_machine.json;{flat}/{tag}_process.json", "--load-filaments", filaments(tag, n),
                         "--outputdir", str(work), "--export-3mf", "tpl.3mf", str(cube)], work, work / "log.txt")
            with zipfile.ZipFile(work / "tpl.3mf") as z: project = json.loads(z.read("Metadata/project_settings.config"))
            if p["tower_y"] is not None: project["wipe_tower_y"] = [str(p["tower_y"])]
            out.write_text(json.dumps(project)); shutil.rmtree(work)
            print("template", tag, n, "exit", code, flush=True)


def filaments(tag, n):
    return ";".join(f"{DATA}/flat/{tag}_f{i}.json" for i in range(1, n + 1))


def colours_of(path):
    with zipfile.ZipFile(path) as z:
        try: c = json.loads(z.read("Metadata/project_settings.config")).get("filament_colour", [])
        except (KeyError, ValueError): c = []
    return c or COLOURS[:1]


def picture_of(path):
    """The plate picture a slicer saved into the 3MF, as a data URL (none for STLs and bare 3MFs)."""
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())
            for n in ("Metadata/plate_1.png", "Metadata/plate_1_small.png", "Auxiliaries/.thumbnails/thumbnail_middle.png", "Metadata/thumbnail.png"):
                if n in names and z.getinfo(n).file_size < 600_000:
                    return "data:image/png;base64," + base64.b64encode(z.read(n)).decode()
    except (zipfile.BadZipFile, OSError): pass
    return None


def slice_one(tag, model, n, work):
    p = PRINTERS[tag]; d = work / tag; d.mkdir()
    maps = " ".join(["1"] * n) if p["map"] == "single" else " ".join(str(i) for i in range(1, n + 1))
    run_py("patch3mf.py", model, d / "in.3mf", maps, DATA / "tpl" / f"{tag}_{n}.json")
    t0 = time.time()
    code = orca(["--load-settings", f"{DATA}/flat/{tag}_machine.json;{DATA}/flat/{tag}_process.json", "--load-filaments", filaments(tag, n),
                 "--arrange", "1", "--slice", "1", "--outputdir", str(d), str(d / "in.3mf")], d, d / "log.txt")
    gcode = d / "plate_1.gcode"
    if code != 0 or not gcode.exists():
        err = "slicing failed"
        try: err = json.loads((d / "result.json").read_text()).get("error_string", err)
        except (OSError, ValueError): pass
        return {"printer": p["name"], "error": err}
    r = json.loads(run_py("stats.py", gcode, p["tc_extra"]))
    if p["map"] != "single":     # no purge chute on a toolchanger: what is left over is ramming and priming on the tower
        r["tower"], r["flush"] = round(r["tower"] + r["flush"], 2), 0.0
    r.update(printer=p["name"], slice_seconds=round(time.time() - t0, 1))
    if tag == "quadro":       # the toolpath the page's printer plays when this file is printed on its screen
        run_py("toolpath.py", gcode, d / "toolpath.json")
        r["toolpath"] = json.loads((d / "toolpath.json").read_text())
    return r


JOBS = {}            # job id -> (time, path of the Quadro G-code)
busy = threading.Semaphore(int(os.environ.get("PARALLEL_JOBS", "2")))
pool = ThreadPoolExecutor(6)


def slice_upload(data, filename, emit=lambda event: None):
    work = pathlib.Path(tempfile.mkdtemp(dir=DATA))
    ext = ".stl" if filename.lower().endswith(".stl") else ".3mf"
    src = work / ("upload" + ext); src.write_bytes(data)
    if ext == ".stl":      # a plain mesh: let OrcaSlicer build the project, printed in one colour
        emit({"stage": "converting"})
        code = orca(["--load-settings", f"{DATA}/flat/quadro_machine.json;{DATA}/flat/quadro_process.json", "--load-filaments", filaments("quadro", 1),
                     "--outputdir", str(work), "--export-3mf", "model.3mf", str(src)], work, work / "convert.txt")
        if code != 0: return {"error": "The STL could not be read."}
        src = work / "model.3mf"
    try: colours = colours_of(src)
    except zipfile.BadZipFile: return {"error": "This is not a 3MF or STL file."}
    n = len(colours)
    if n > 4: return {"error": f"The model uses {n} colours; these printers hold at most 4."}
    emit({"stage": "slicing", "printers": list(PRINTERS), "colours": colours, "thumb": picture_of(src)})
    futures, results = {pool.submit(slice_one, t, src, n, work): t for t in PRINTERS}, {}
    for f in as_completed(futures):
        t = futures[f]; results[t] = f.result()
        emit({"done": t, "seconds": results[t].get("slice_seconds"), "error": results[t].get("error")})
    results = {t: results[t] for t in PRINTERS}
    job = uuid.uuid4().hex[:12]
    q = work / "quadro" / "plate_1.gcode"
    if q.exists(): JOBS[job] = (time.time(), q, re.sub(r"[^\w.\- ]", "_", re.sub(r"\.(3mf|stl)$", "", filename, flags=re.I)) + ".gcode")
    for k, (t, path, _) in list(JOBS.items()):          # keep G-code for an hour
        if time.time() - t > 3600:
            JOBS.pop(k, None); shutil.rmtree(path.parent.parent, ignore_errors=True)
    return {"job": job if q.exists() else None, "file": filename, "colours": colours, "printers": results}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"           # chunked responses for the progress stream

    def cors(self):
        o = self.headers.get("Origin", "")
        self.send_header("Access-Control-Allow-Origin", o if o in ORIGINS or "*" in ORIGINS else ORIGINS[0])
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename"); self.send_header("Vary", "Origin")

    def reply(self, code, body, ctype="application/json", filename=None):
        data = body if isinstance(body, bytes) else json.dumps(body, separators=(",", ":")).encode()
        self.send_response(code); self.cors(); self.send_header("Content-Type", ctype)
        if filename: self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
        if code >= 400: self.send_header("Connection", "close"); self.close_connection = True   # the upload may be unread
        if len(data) > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            data = gzip.compress(data, 5); self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(data))); self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0"); self.end_headers()

    def stream(self):
        """Open a progress stream: NDJSON in HTTP chunks, gzip-compressed when the client takes it, with a sync flush
        after every line so each event reaches the page as it happens. Returns emit(event); emit(None) ends it."""
        self.send_response(200); self.cors(); self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache"); self.send_header("Transfer-Encoding", "chunked"); self.send_header("Connection", "close")
        z = zlib.compressobj(5, zlib.DEFLATED, 31) if "gzip" in self.headers.get("Accept-Encoding", "") else None
        if z: self.send_header("Content-Encoding", "gzip")
        self.end_headers(); self.close_connection = True
        lock = threading.Lock()

        def emit(event):
            raw = b"" if event is None else json.dumps(event, separators=(",", ":")).encode() + b"\n"
            data = z.compress(raw) + z.flush(zlib.Z_FINISH if event is None else zlib.Z_SYNC_FLUSH) if z else raw
            with lock:
                try:
                    if data: self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                    if event is None: self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except OSError: pass        # the page went away; the slice still finishes and is dropped
        return emit

    def do_GET(self):
        if self.path == "/health": return self.reply(200, {"ok": True})
        m = re.fullmatch(r"/gcode/([0-9a-f]{12})", self.path)
        if m and m.group(1) in JOBS:
            t, path, name = JOBS[m.group(1)]
            return self.reply(200, path.read_bytes(), "text/plain; charset=utf-8", name)
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/slice": return self.reply(404, {"error": "not found"})
        if self.headers.get("Origin", "null") not in ORIGINS and "*" not in ORIGINS: return self.reply(403, {"error": "forbidden"})
        size = int(self.headers.get("Content-Length", 0))
        if not 0 < size <= MAX_BYTES: return self.reply(413, {"error": f"Upload a file up to {MAX_BYTES >> 20} MB."})
        data, name = self.rfile.read(size), self.headers.get("X-Filename", "model.3mf")
        if "application/x-ndjson" in self.headers.get("Accept", ""):
            emit = self.stream()
            emit({"stage": "received", "bytes": size})
            if not busy.acquire(blocking=False):
                emit({"stage": "queued"})
                if not busy.acquire(timeout=120):
                    emit({"error": "The slicer is busy, try again in a minute."}); return emit(None)
            try: emit({"result": slice_upload(data, name, emit)})
            except subprocess.TimeoutExpired: emit({"error": "Slicing took too long for this model."})
            except Exception as e: emit({"error": "Slicing failed: " + str(e)[:200]})
            finally: busy.release(); emit(None)
            return
        if not busy.acquire(timeout=120): return self.reply(503, {"error": "The slicer is busy, try again in a minute."})
        try: self.reply(200, slice_upload(data, name))
        except subprocess.TimeoutExpired: self.reply(504, {"error": "Slicing took too long for this model."})
        except Exception as e: self.reply(500, {"error": "Slicing failed: " + str(e)[:200]})
        finally: busy.release()


if __name__ == "__main__":
    DATA.mkdir(parents=True, exist_ok=True)
    prepare()                                   # done once at image build ("--prepare"); a no-op after that
    if "--prepare" in sys.argv: sys.exit(0)
    port = int(os.environ.get("PORT", "8080"))
    print("listening on", port, flush=True)
    ThreadingHTTPServer(("", port), Handler).serve_forever()

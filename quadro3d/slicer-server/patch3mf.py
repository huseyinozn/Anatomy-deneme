#!/usr/bin/env python3
"""Set the filament-to-nozzle map of every plate in a Bambu/Orca 3MF, which OrcaSlicer 2.4 reads from the plate
metadata in Metadata/model_settings.config (the CLI has no switch for it). A 3MF without plates gets one plate that
holds every object.
usage: patch3mf.py in.3mf out.3mf "1 2 3 4" printer_project_settings.json"""
import json, re, sys, zipfile

src, dst, maps = sys.argv[1], sys.argv[2], sys.argv[3]
SETTINGS = "Metadata/model_settings.config"
meta = lambda k, v: '<metadata key="%s" value="%s"/>' % (k, v)

with zipfile.ZipFile(src) as zin:
    names = zin.namelist()
    cfg = zin.read(SETTINGS).decode("utf-8") if SETTINGS in names else '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n</config>\n'
    if "<plate>" not in cfg:
        model = zin.read("3D/3dmodel.model").decode("utf-8", "replace")
        build = re.search(r"<build[^>]*>(.*?)</build>", model, re.S)
        ids = re.findall(r'objectid="(\d+)"', build.group(1) if build else "")
        inst = "".join("<model_instance>%s%s</model_instance>" % (meta("object_id", i), meta("instance_id", 0)) for i in ids)
        cfg = cfg.replace("</config>", "<plate>%s%s</plate>\n</config>" % (meta("plater_id", 1), inst))
    cfg = re.sub(r'\s*<metadata key="(filament_map_mode|filament_maps)" value="[^"]*"\s*/>', "", cfg)
    cfg = cfg.replace("<plate>", "<plate>" + meta("filament_map_mode", "Manual") + meta("filament_maps", maps))
    # keep only the filament colours of the project settings: everything else came from whatever printer the file
    # was made for and must not leak into the printer we slice for
    PROJECT = "Metadata/project_settings.config"
    # so the target printer's complete project settings (exported by OrcaSlicer itself) replace them; only the
    # file's own filament colours are kept
    project = json.load(open(sys.argv[4]))
    if PROJECT in names:
        try:
            colours = json.loads(zin.read(PROJECT)).get("filament_colour", [])
            if len(colours) == len(project["filament_colour"]): project["filament_colour"] = colours
        except ValueError: pass
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            if n not in (SETTINGS, PROJECT): zout.writestr(n, zin.read(n))
        zout.writestr(SETTINGS, cfg)
        zout.writestr(PROJECT, json.dumps(project, indent=1))
print(dst)

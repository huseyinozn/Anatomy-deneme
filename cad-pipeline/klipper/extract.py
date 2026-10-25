"""Read the printer's config the way Klipper's configfile.py does: includes parsed in order into one
RawConfigParser (strict=False, inline comments ; #), then the #*# SAVE_CONFIG block on top.
Writes {section: {option: value}} as JSON."""
import configparser, io, json, pathlib, re, sys
root, top, out = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
cp = configparser.RawConfigParser(strict=False, inline_comment_prefixes=(";", "#"))
sect = configparser.RawConfigParser.SECTCRE
def parse(name, autosave, top=False):
    text = (root / name).read_text(encoding="utf-8", errors="replace")
    if top and "\n#*#" in text:
        body, auto = text.split("\n#*#", 1)
        lines = [l[4:] if l.startswith("#*# ") else l[3:] for l in ("#*#" + auto).split("\n")]
        while lines and not lines[0].lstrip().startswith("["): lines.pop(0)
        autosave.append("\n".join(lines))
    else:
        body = text
    buf = []
    for line in body.split("\n"):
        pos = line.find("#")
        m = sect.match(line)
        header = m and m.group("header")
        if header and header.startswith("include "):
            cp.read_string("\n".join(buf)); buf = []
            parse(header[8:].strip(), autosave)
        else:
            buf.append(line)
    cp.read_string("\n".join(buf))
autosave = []
parse(top, autosave, True)
for a in autosave: cp.read_string(a)
json.dump({s: dict(cp.items(s)) for s in cp.sections()}, open(out, "w"), indent=1, ensure_ascii=False)
print(len(cp.sections()), "sections")

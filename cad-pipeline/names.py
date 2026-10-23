import re, sys, json
txt = open(sys.argv[1], encoding="latin-1").read().replace("\r", "").replace("\n", "")
ent = dict(re.findall(r"#(\d+)\s*=\s*(.*?);(?=\s*#\d+\s*=|\s*ENDSEC)", txt))
def args(s): return s
prod = {}
for k, v in ent.items():
    if v.startswith("PRODUCT ("): prod[k] = re.match(r"PRODUCT \( '([^']*)'", v).group(1)
pdf = {}   # product_definition_formation -> product
for k, v in ent.items():
    if v.startswith("PRODUCT_DEFINITION_FORMATION"):
        m = re.findall(r"#(\d+)", v); pdf[k] = prod.get(m[-1])
pd = {}
for k, v in ent.items():
    if v.startswith("PRODUCT_DEFINITION ("):
        m = re.findall(r"#(\d+)", v); pd[k] = pdf.get(m[0])
out = {}
for k, v in ent.items():
    if v.startswith("NEXT_ASSEMBLY_USAGE_OCCURRENCE"):
        nid = re.match(r"NEXT_ASSEMBLY_USAGE_OCCURRENCE \( '([^']*)'", v).group(1)
        refs = re.findall(r"#(\d+)", v)
        out[nid] = {"parent": pd.get(refs[0]), "child": pd.get(refs[1])}
json.dump(out, open(sys.argv[2], "w"), indent=1, ensure_ascii=False)
for nid, r in sorted(out.items(), key=lambda x: int(x[0][4:])): print(nid, "|", r["parent"], "->", r["child"])

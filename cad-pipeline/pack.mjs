// Prepare the Quadro CAD export for the web: drop misplaced and duplicate parts, simplify, compress.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, weld, simplify, prune, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
import { readFileSync } from "node:fs";

const [input, output, ratio = "0.25", error = "0.0004", namesFile, compress = "no"] = process.argv.slice(2);
const NAMES = namesFile ? JSON.parse(readFileSync(namesFile, "utf8")) : {};
// STEP escapes non-ASCII as \X2\hhhh\X0\; turn them back into letters
const unstep = (t) => t.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_, hex) => hex.match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join(""));
const DROP = new Set([
  // copies parked far left of the machine in this older assembly
  "NAUO380", "NAUO381", "NAUO382", "NAUO383", "NAUO384", "NAUO385", "NAUO386", "NAUO387", "NAUO388", "NAUO389", "NAUO390", "NAUO391", "NAUO392",
  // four of the eight toolheads: the machine runs four
  "NAUO52", "NAUO53", "NAUO56", "NAUO57",
  // loose parts beyond the right end of the beam
  "NAUO32", "NAUO36",
]);
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(input);
for (const node of doc.getRoot().listNodes()) if (DROP.has(node.getName())) node.dispose();
// name every node "NAUO12:part name" so the page can colour and move parts by name
for (const node of doc.getRoot().listNodes()) {
  const id = node.getName(), part = NAMES[id]?.child;
  if (part) node.setName(id + ":" + unstep(part).replace(/\^.*$/, ""));
}
await doc.transform(
  prune(),
  dedup(),
  weld({ tolerance: 0.0001 }),
  simplify({ simplifier: MeshoptSimplifier, ratio: Number(ratio), error: Number(error) }),
  prune(),
  reorder({ encoder: MeshoptEncoder }),
  quantize(),
);
if (compress === "yes") doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(output, doc);
let tris = 0;
for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
console.log("triangles", tris, "nodes", doc.getRoot().listNodes().length);

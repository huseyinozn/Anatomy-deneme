// Replace parts of the assembly GLB with updated per-part GLBs, placed in each occurrence's frame.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { mergeDocuments } from "@gltf-transform/functions";
import { readFileSync } from "node:fs";

const [input, specFile, output] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, "utf8")); // [{occ, file, matrix?}]
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const byName = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
const dropTree = (n) => { for (const c of n.listChildren()) { dropTree(c); c.dispose(); } };
for (const { occ, file, matrix } of spec) {
  const host = byName.get(occ);
  if (!host) { console.log("missing", occ); continue; }
  host.setMesh(null); dropTree(host);
  const src = await io.read(file);
  const srcScene = src.getRoot().listScenes()[0];
  const map = mergeDocuments(doc, src);
  const scene = map.get(srcScene);
  const holder = doc.createNode(occ + "_new");
  if (matrix) holder.setMatrix(matrix);
  for (const r of scene.listChildren()) { scene.removeChild(r); holder.addChild(r); }
  host.addChild(holder);
  scene.dispose();
}
const [buf, ...extra] = doc.getRoot().listBuffers();
for (const a of doc.getRoot().listAccessors()) a.setBuffer(buf);
for (const b of extra) b.dispose();
await io.write(output, doc);
console.log("swapped", spec.length);

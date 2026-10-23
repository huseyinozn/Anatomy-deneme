// Quadro: a bed-slinger with four independent toolheads on one X beam, Qdock parking at both ends, synchronised toolchange moves.
// Build: node quadro/build.mjs  ->  quadro/quadro.html (standalone, no dependencies)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../.claude/skills/anatomy/kit/iso-kit.mjs";
import { kitScript } from "../.claude/skills/anatomy/scripts/inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDTH = 900;
const HEIGHT = 700;

// Everything below runs in the page: the scene is rebuilt from world geometry whenever the camera changes.
const live = String.raw`
const W = ${WIDTH}, H = ${HEIGHT};
const COLORS = ["#3e7bd6", "#b9b3a6", "#e5484d", "#e0a93b"];

// ---- world, in millimetres: x along the beam, y front-back (nozzle line at y = 0), z up ----
const BASE = { x: -90, y: -250, w: 480, d: 500, r: 44 }, BASE_Z0 = -80;
const SLOTS = [70, 230];
const BED_TOP = 40;
const NZ = BED_TOP + 2;                  // nozzle tip height (first layer)
const UP = [{ x: -128, y: -152, w: 44, d: 58, r: 4 }, { x: 384, y: -152, w: 44, d: 58, r: 4 }];
const UP_TOP = 650, SPOOL_Y = -123;
const BEAM = { x: -240, y: -92, w: 780, d: 60, r: 4 }, BEAM_Z0 = NZ + 130, BEAM_Z1 = NZ + 185;
const HEAD_W = 55;
const LP = [-174, -116, -58];            // left Qdock slots L1, L2, L3 (Tool 0, 1, 2)
const RP = [358, 416, 474];              // right Qdock slots R1, R2, R3 (Tool 1, 2, 3)

// ---- the print job: each head owns one shape on the 300 x 300 bed ----
const poly = (cx, cy, r, n, rot) => Array.from({ length: n + 1 }, (_, i) => {
  const a = rot + (i / n) * Math.PI * 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
const SHAPES = [
  [[45, 45], [130, 45], [130, 130], [45, 130], [45, 45]],
  poly(215, 88, 45, 48, Math.PI),
  poly(88, 215, 50, 3, -Math.PI / 2),
  poly(215, 215, 47, 6, 0),
];
const lengthOf = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const pointAlong = (pts, dist) => {
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (dist <= seg) { const f = seg ? dist / seg : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]; }
    dist -= seg;
  }
  return pts[pts.length - 1];
};
const PROGRAM = [0, 2, 1, 3];

// ---- settings the user can change ----
const cfg = { vx: 600, ax: 6000, vy: 400, ay: 4000, print: 150, scale: 0.5, az: 42, el: 30 };
for (const [key, value] of new URLSearchParams(location.hash.slice(1))) if (key in cfg && Number.isFinite(Number(value))) cfg[key] = Number(value);

// ---- state ----
let xs = [LP[0], RP[0], RP[1], RP[2]];
let ny = 150;                              // nozzle Y on the bed
let active = -1, jobAt = 0, queued = null, cycles = 0;
let phase = { kind: "idle" };
let trails = [];
let playing = !matchMedia("(prefers-reduced-motion: reduce)").matches;
let P;

// ---- helpers ----
const S = (paths, o) => solidSvg(paths, o);
const Ln = (d, o) => lineSvg(d, o);
const Dt = (pts, o) => dotsSvg(pts, o);
const at = (p) => iso(p, P);
const byDepth = (items) => items.sort((a, b) => a.depth - b.depth).map((i) => i.svg).join("");
const fmt = (v, n = 0) => v.toFixed(n).replace(".", ",").replace("-", "−");

// ================= geometry =================
// Bed-slinger: the bed carries Y, the four heads share one X beam, the beam rides Z on two uprights.
// Painter's order (valid for azimuth 25..70): base, left spools, left upright, left dock, bed,
// right upright, crossbar, right spools, screen, right dock, then the beam and the heads left to right.
function xDisc(x0, x1, cy, cz, r, tone, extra = "") {
  const pts = [];
  for (const x of [x0, x1]) for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push(at([x, cy + r * Math.cos(a), cz + r * Math.sin(a)])); }
  const hull = pathOf(convexHull(pts), true);
  const face = sideRing([x1, cy, cz], r, "x", P, 48);
  return '<g class="iso-solid"' + extra + '><path class="iso-fill" d="' + hull + '"/><path class="iso-shade" data-shade="2" d="' + hull + '"/><path class="iso-top" d="' + face + '"/><path class="iso-line iso-edge" data-tone="' + tone + '" d="' + hull + '"/><path class="iso-line" data-tone="' + tone + '" d="' + face + '"/></g>';
}
function spoolSvg(xIn, xOut, cy, cz, color) {
  const lo = Math.min(xIn, xOut), hi = Math.max(xIn, xOut);
  return xDisc(lo, lo + 4, cy, cz, 90, "lo")
    + xDisc(lo + 4, hi - 4, cy, cz, 78, "lo", ' style="--q-spool:' + color + '" data-spool')
    + xDisc(hi - 4, hi, cy, cz, 90, "lo")
    + Ln(sideRing([hi, cy, cz], 26, "x", P, 32) + sideRing([hi, cy, cz], 62, "x", P, 48), { tone: "faint" })
    + Dt([at([hi, cy, cz])], { size: 0.6 });
}
function spools(side) {
  const [xIn, xOut] = side < 0 ? [UP[0].x - 12, UP[0].x - 77] : [UP[1].x + UP[1].w + 12, UP[1].x + UP[1].w + 77];
  const arm = (cz) => {
    const x0 = side < 0 ? xIn : UP[1].x + UP[1].w, x1 = side < 0 ? UP[0].x : xIn;
    return S(slabOf({ x: x0, y: SPOOL_Y - 9, w: x1 - x0, d: 18, r: 2 }, cz - 9, 18, P, 2), { tone: "mid" });
  };
  const [top, low] = side < 0 ? [COLORS[0], COLORS[1]] : [COLORS[2], COLORS[3]];
  // the outer spool is further from the viewer on the left side, nearer on the right
  return side < 0
    ? spoolSvg(xIn, xOut, SPOOL_Y, 470, top) + spoolSvg(xIn, xOut, SPOOL_Y, 205, low) + arm(470) + arm(205)
    : arm(470) + arm(205) + spoolSvg(xIn, xOut, SPOOL_Y, 470, top) + spoolSvg(xIn, xOut, SPOOL_Y, 205, low);
}

function baseSvg() {
  const out = ['<path class="iso-halo" d="' + haloOf(BASE, BASE_Z0, -BASE_Z0, P) + '"/>'];
  out.push(S(slabOf(insetPlan(BASE, 10), BASE_Z0, 12, P, 2), { tone: "lo" }));
  out.push(S(slabOf(BASE, BASE_Z0 + 12, -BASE_Z0 - 12, P, 2, 3), { tone: "mid", inner: Ln(sideSeam(BASE, -20, P, 2), { tone: "faint" }) }));
  out.push(faceTextSvg(sideMatrix([BASE.x + BASE.w - 120, BASE.y + BASE.d], -38, P, "left"), "QUADRO", { size: 12, tone: "mid", anchor: "middle" }));
  // the two slots the bed carriage runs in
  for (const sx of SLOTS) out.push(S(slabOf({ x: sx - 6, y: -232, w: 12, d: 464, r: 6 }, -0.1, 0.1, P, 4), { tone: "lo", flat: true }));
  out.push(Dt(corners(insetPlan(BASE, 10), 18).map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  return out.join("");
}

function uprightSvg(u) {
  const out = [];
  out.push(S(slabOf(insetPlan(u, -8), BASE_Z0, 34, P, 3, 1), { tone: "lo" }));
  out.push(S(slabOf(u, BASE_Z0 + 34, UP_TOP - BASE_Z0 - 34, P, 3, 1), { tone: "mid", inner: Ln(sideSeam(u, 120, P, 3), { tone: "faint" }) }));
  // vertical groove of the extrusion on its front face
  out.push(Ln(segment([u.x + u.w / 2, u.y + u.d, BASE_Z0 + 40], [u.x + u.w / 2, u.y + u.d, UP_TOP - 6], P), { tone: "faint" }));
  return out.join("");
}
function crossbarSvg() {
  const bar = { x: UP[0].x, y: UP[0].y, w: UP[1].x + UP[1].w - UP[0].x, d: UP[0].d, r: 4 };
  let out = S(slabOf(insetPlan(bar, 4), UP_TOP, 46, P, 3, 1.4), { tone: "mid", inner: Ln(sideSeam(insetPlan(bar, 4), UP_TOP + 23, P, 3), { tone: "faint" }) });
  for (const u of UP) out += S(slabOf(insetPlan(u, -4), UP_TOP - 6, 56, P, 2, 1.4), { tone: "lo" });
  return out;
}

function dockSvg(side) {
  const bar = side < 0 ? { x: -215, y: -10, w: 195, d: 48, r: 3 } : { x: 320, y: -10, w: 195, d: 48, r: 3 };
  const bracket = side < 0 ? { x: -238, y: -30, w: 22, d: 34, r: 2 } : { x: 516, y: -30, w: 22, d: 34, r: 2 };
  const slots = side < 0 ? LP : RP;
  const out = [];
  const arm = S(slabOf(bracket, NZ - 16, BEAM_Z0 - (NZ - 16), P, 2, 0.6), { tone: "lo" });
  if (side < 0) out.push(arm);
  out.push(S(slabOf(bar, NZ - 16, 12, P, 3, 0.8), { tone: "lo" }));
  out.push(Ln(slots.map((cx) => ring(cx, 4, 7, NZ - 4, P, 20)).join(""), { tone: "mid" }));
  out.push(Dt(slots.map((cx) => at([cx, 26, NZ - 4])), { size: 0.45, tone: "lo" }));
  out.push(faceTextSvg(sideMatrix([side < 0 ? bar.x + bar.w - 46 : bar.x + 46, bar.y + bar.d], NZ - 12, P, "left"), "Qdock", { size: 6, tone: "mid", anchor: "middle" }));
  if (side > 0) out.push(arm);
  return out.join("");
}

function bedSvg() {
  const carriage = { x: 40, y: 50, w: 220, d: 200, r: 4 };
  const body = { x: -14, y: -14, w: 328, d: 328, r: 6 };
  const plate = { x: 0, y: 0, w: 300, d: 300, r: 4 };
  let grid = "";
  for (const v of [75, 150, 225]) grid += lineOnTop([v, 0], [v, 300], BED_TOP, P) + lineOnTop([0, v], [300, v], BED_TOP, P);
  return S(slabOf(carriage, 0, 12, P, 3), { tone: "lo" })
    + S(slabOf(body, 12, 22, P, 6, 1.4), { tone: "mid" })
    + faceTextSvg(sideMatrix([16, body.y + body.d], 25, P, "left"), "QUADRO", { size: 8, tone: "hi" })
    + faceTextSvg(sideMatrix([80, body.y + body.d], 25, P, "left"), "300 × 300 × 300 mm", { size: 6.5, tone: "mid" })
    + S(slabOf(plate, 34, BED_TOP - 34, P, 4, 1), { tone: "mid" })
    + Ln(grid, { tone: "faint" })
    + Ln(planOutline(insetPlan(plate, 5), BED_TOP, P, 4), { tone: "lo" });
}

function screenSvg() {
  const stand = { x: 300, y: 178, w: 100, d: 58, r: 10 };
  const panel = insetPlan(stand, 6);
  const tiles = [0, 1, 2, 3].map((j) => S(slabOf({ x: panel.x + 14 + j * 17, y: panel.y + 18, w: 12, d: 12, r: 1.5 }, 14, 0.6, P, 2), { tone: "mid", className: "q-c" + j })).join("");
  return S(slabOf(stand, 0, 8, P, 4, 1), { tone: "mid" }) + S(slabOf(panel, 8, 6, P, 4, 0.8), { tone: "lo" }) + Ln(planOutline(insetPlan(panel, 5), 14, P, 3), { tone: "mid" }) + tiles;
}

function beamSvg() {
  const out = [];
  out.push(S(slabOf(BEAM, BEAM_Z0, BEAM_Z1 - BEAM_Z0, P, 3, 1.6), { tone: "mid", inner: Ln(sideSeam(BEAM, BEAM_Z0 + 18, P, 3), { tone: "faint" }) }));
  const rail = { x: BEAM.x + 12, y: BEAM.y + 8, w: BEAM.w - 24, d: 22, r: 2 };
  out.push(S(slabOf(rail, BEAM_Z1, 8, P, 2, 0.6), { tone: "mid" }));
  const holes = [];
  for (let x = rail.x + 15; x < rail.x + rail.w - 10; x += 25) holes.push(at([x, rail.y + 11, BEAM_Z1 + 8]));
  out.push(Dt(holes, { size: 0.45, tone: "lo" }));
  // end blocks carry the dock arms and the beam's Z carriages
  for (const ex of [BEAM.x, BEAM.x + BEAM.w - 26]) out.push(S(slabOf({ x: ex, y: BEAM.y - 4, w: 26, d: BEAM.d + 8, r: 2 }, BEAM_Z0 - 4, BEAM_Z1 - BEAM_Z0 + 8, P, 2, 0.6), { tone: "lo" }));
  return out.join("");
}

function headSvg(j) {
  const lit = j === active;
  const o = [];
  o.push(S(slabOf({ x: -18, y: -16, w: 36, d: 32, r: 3 }, NZ + 10, 16, P, 2), { tone: "lo" }));
  o.push(S(cylinder(0, 0, 4, NZ + 4, 6, P, 16), { tone: "hi", lit }));
  o.push(S(cylinder(0, 0, 1.8, NZ, 4, P, 12), { tone: "hi", lit }));
  const body = { x: -HEAD_W / 2, y: -30, w: HEAD_W, d: 60, r: 7 };
  o.push(S(slabOf(body, NZ + 26, 180, P, 4, 1), { tone: lit ? "hi" : "mid", crease: lit ? "lo" : "faint", inner: Ln(sideSeam(body, NZ + 62, P, 4), { tone: "faint" }) }));
  const cap = insetPlan(body, 3.5);
  o.push(S(slabOf(cap, NZ + 206, 14, P, 4, 1), { tone: lit ? "hi" : "mid", crease: lit ? "lo" : "faint" }));
  o.push(S(cylinder(0, -4, 4.5, NZ + 220, 10, P, 16), { tone: "lo" }));
  o.push(Dt([at([0, -4, NZ + 230])], { size: 0.5 }));
  o.push('<path class="q-led" stroke="' + COLORS[j] + '" d="' + segment([-8, 30, NZ + 184], [8, 30, NZ + 184], P) + '"/>');
  o.push(faceTextSvg(sideMatrix([0, 30], NZ + 46, P, "left"), "Tool " + j, { size: 6.5, tone: lit ? "hi" : "mid", anchor: "middle" }));
  o.push(Ln(segment([-9, 30, NZ + 40], [9, 30, NZ + 40], P), { tone: "lo" }));
  o.push(Dt([[-20, NZ + 170], [-20, NZ + 80]].map(([y, z]) => at([HEAD_W / 2, y, z])), { size: 0.45 }));
  return o.join("");
}

// ================= scene =================
const svg = document.querySelector(".iso-stage svg");
const layer = (name) => svg.querySelector('[data-layer="' + name + '"]');
function fitView() {
  const pts = [...boxCorners(BASE, BASE_Z0, 0)];
  pts.push(...boxCorners({ x: UP[0].x - 4, y: UP[0].y - 4, w: UP[1].x + UP[1].w - UP[0].x + 8, d: UP[0].d + 8, r: 0 }, BASE_Z0, UP_TOP + 50));
  pts.push(...boxCorners({ x: UP[0].x - 77, y: SPOOL_Y - 90, w: UP[1].x + UP[1].w - UP[0].x + 154, d: 180, r: 0 }, 115, 560));
  pts.push(...boxCorners({ x: BEAM.x, y: -30, w: BEAM.w, d: 60, r: 0 }, NZ, BEAM_Z1 + 10));
  pts.push(...boxCorners({ x: -14, y: -314, w: 328, d: 628, r: 0 }, 0, BED_TOP));
  P = fitProjection(pts, W, H, { pad: 14, azimuth: cfg.az, elevation: cfg.el });
}
function buildScene() {
  fitView();
  layer("back").innerHTML = baseSvg() + spools(-1) + uprightSvg(UP[0]) + dockSvg(-1);
  layer("bed").innerHTML = bedSvg() + '<g data-layer="trails"></g>';
  layer("mid").innerHTML = uprightSvg(UP[1]) + crossbarSvg() + spools(1) + screenSvg() + dockSvg(1);
  for (const t of trails) { layer("trails").appendChild(t.el); t.dirty = true; }
  layer("gantry").innerHTML = beamSvg() + [0, 1, 2, 3].map((j) => '<g data-head="' + j + '">' + headSvg(j) + "</g>").join("");
  draw();
}
function draw() {
  layer("bed").setAttribute("transform", translateAlong(P, [0, -ny, 0]));
  layer("gantry").querySelectorAll("[data-head]").forEach((g, j) => g.setAttribute("transform", translateAlong(P, [xs[j], 0, 0])));
  for (const t of trails) if (t.dirty) { t.el.setAttribute("d", pathOf(t.pts.map(([x, y]) => at([x, y, BED_TOP + 0.4])))); t.dirty = false; }
}

// ================= motion =================
// Fastest time for one axis on its own trapezoid, and the accel share of that time.
function solo(d, v, a) {
  d = Math.abs(d);
  if (d < 1e-6) return { T: 0, f: 0.5 };
  if (d > (v * v) / a) { const T = d / v + v / a; return { T, f: v / a / T }; }
  return { T: 2 * Math.sqrt(d / a), f: 0.5 };
}
// Shortest common T for a shared profile shape f, so no axis exceeds its own v and a.
function commonT(axes, f) {
  return Math.max(...axes.map(({ d, v, a }) => { d = Math.abs(d); return Math.max(d / (v * (1 - f)), Math.sqrt(d / (a * f * (1 - f)))); }));
}
function ease(t, T, f) {           // normalised trapezoid, 0..1
  if (T <= 0) return 1;
  const ta = f * T, vn = 1 / (T - ta), an = vn / ta;
  if (t <= 0) return 0;
  if (t >= T) return 1;
  if (t < ta) return 0.5 * an * t * t;
  if (t < T - ta) return 0.5 * an * ta * ta + vn * (t - ta);
  return 1 - 0.5 * an * (T - t) * (T - t);
}

function startToolchange(next) {
  const [sx, sy] = SHAPES[next][0];
  const to = xs.map((_, j) => (j < next ? LP[j] : j > next ? RP[j - 1] : sx));
  const axes = to.map((t, j) => ({ d: t - xs[j], v: cfg.vx, a: cfg.ax })).concat([{ d: sy - ny, v: cfg.vy, a: cfg.ay }]);
  const lead = axes.map((ax) => solo(ax.d, ax.v, ax.a)).reduce((m, s) => (s.T > m.T ? s : m), { T: 0, f: 0.5 });
  const f = lead.f, T = commonT(axes, f);
  const vn = T > 0 ? 1 / (T - f * T) : 0;
  phase = { kind: "change", t: 0, T, f, from: xs.slice(), to, y0: ny, y1: sy, prev: active, next, peaks: axes.map((ax) => Math.abs(ax.d) * vn) };
  active = next;
  buildHeads();
  const names = ["T0", "T1", "T2", "T3", "Y tabla"];
  const moves = axes.map((ax, i) => (Math.abs(ax.d) < 0.5 ? null : names[i] + " " + (ax.d > 0 ? "+" : "") + fmt(ax.d) + " mm (tepe " + fmt(phase.peaks[i]) + " mm/s)")).filter(Boolean);
  changeEl.innerHTML = "<b>Son eşzamanlı hareket: " + (phase.prev < 0 ? "başlangıç" : "T" + phase.prev) + " → T" + next + " · " + fmt(T, 2) + " s</b><br>" + moves.join(" · ");
}
function startPrint() {
  if (cycles > 0 && jobAt === 0 && cycles % 2 === 0) { trails = []; layer("trails").innerHTML = ""; }
  const t = { c: active, pts: [SHAPES[active][0].slice()] };
  t.el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  t.el.setAttribute("class", "q-trail");
  t.el.setAttribute("stroke", COLORS[active]);
  layer("trails").appendChild(t.el);
  trails.push(t);
  phase = { kind: "print", s: 0, L: lengthOf(SHAPES[active]), trail: t };
}
function nextJob() {
  let next;
  if (queued !== null) { next = queued; queued = null; }
  else { next = PROGRAM[jobAt]; jobAt = (jobAt + 1) % PROGRAM.length; if (jobAt === 0) cycles++; }
  startToolchange(next);
}
function buildHeads() {
  layer("gantry").querySelectorAll("[data-head]").forEach((g, j) => { g.innerHTML = headSvg(j); });
}

function step(dt) {
  if (phase.kind === "idle") return nextJob();
  if (phase.kind === "change") {
    phase.t = Math.min(phase.T, phase.t + dt);
    const u = ease(phase.t, phase.T, phase.f);
    xs = phase.from.map((x0, j) => x0 + (phase.to[j] - x0) * u);
    ny = phase.y0 + (phase.y1 - phase.y0) * u;
    if (phase.t >= phase.T) { phase.done = phase.T; startPrint(); }
    return;
  }
  if (phase.kind === "print") {
    phase.s = Math.min(phase.L, phase.s + cfg.print * dt);
    const [x, y] = pointAlong(SHAPES[active], phase.s);
    xs[active] = x; ny = y;
    const tr = phase.trail, last = tr.pts[tr.pts.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) > 1.5 || phase.s >= phase.L) { tr.pts.push([x, y]); tr.dirty = true; }
    if (phase.s >= phase.L) nextJob();
  }
}

// ================= readout and status =================
const readout = document.querySelector("[data-readout]");
const statusEl = document.querySelector("[data-status]");
const changeEl = document.querySelector("[data-change]");
function slotName(j, x) {
  const near = (a) => Math.abs(x - a) < 0.5;
  for (let i = 0; i < 3; i++) { if (near(LP[i])) return "Qdock L" + (i + 1); if (near(RP[i])) return "Qdock R" + (i + 1); }
  return null;
}
function report() {
  let text;
  if (phase.kind === "change") text = "Takım değişimi " + (phase.prev < 0 ? "başlangıç" : "T" + phase.prev) + " → T" + phase.next + " · " + fmt(phase.t, 2) + " / " + fmt(phase.T, 2) + " s";
  else if (phase.kind === "print") text = "T" + active + " baskıda · X " + fmt(xs[active]) + " · Y tabla " + fmt(ny) + " mm";
  else text = "hazır";
  if (readout.textContent !== text) readout.textContent = text;
  const rows = xs.map((x, j) => {
    const where = j === active && phase.kind === "print" ? "baskıda" : slotName(j, x) || (phase.kind === "change" ? "hareket" : "—");
    return '<div class="q-head' + (j === active ? " is-active" : "") + '"><i style="background:' + COLORS[j] + '"></i><b>Tool ' + j + "</b><span>" + where + "</span><em>X " + fmt(x) + "</em></div>";
  }).join("");
  if (statusEl.innerHTML !== rows) statusEl.innerHTML = rows;
}

// ================= loop =================
let last = 0, frame = 0, visible = true;
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
  last = now;
  if (playing) step(dt * cfg.scale);
  draw();
  report();
  frame = playing && visible ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame) { last = 0; frame = requestAnimationFrame(tick); } };
new IntersectionObserver((e) => { visible = e[e.length - 1].isIntersecting; if (visible) run(); }).observe(svg);

// ================= controls =================
const $ = (sel) => document.querySelector(sel);
const playBtn = $("[data-play]");
const setPlaying = (on) => { playing = on; playBtn.textContent = on ? "Durdur" : "Başlat"; playBtn.setAttribute("aria-pressed", String(on)); if (on) run(); };
playBtn.addEventListener("click", () => setPlaying(!playing));
document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
  queued = Number(b.dataset.pick);
  if (phase.kind === "print") { nextJob(); }
  if (!playing) setPlaying(true);
}));
$("[data-clear]").addEventListener("click", () => {
  trails = phase.kind === "print" ? [phase.trail] : [];
  if (phase.kind === "print") { phase.trail.pts = [[xs[active], ny]]; phase.trail.dirty = true; }
  layer("trails").replaceChildren(...trails.map((t) => t.el));
});
document.querySelectorAll("input[data-cfg]").forEach((input) => {
  const key = input.dataset.cfg, out = input.parentElement.querySelector("output");
  const show = () => { out.textContent = key === "scale" ? fmt(cfg[key], 2) + "×" : fmt(cfg[key]); };
  input.value = cfg[key]; show();
  input.addEventListener("input", () => {
    cfg[key] = Number(input.value); show();
    if (key === "az" || key === "el") buildScene();
  });
});
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
  const [az, el] = b.dataset.view.split(",").map(Number);
  cfg.az = az; cfg.el = el;
  document.querySelector('input[data-cfg="az"]').value = az; document.querySelector('input[data-cfg="el"]').value = el;
  document.querySelector('input[data-cfg="az"]').dispatchEvent(new Event("input"));
  document.querySelector('input[data-cfg="el"]').dispatchEvent(new Event("input"));
}));
// drag across the figure to turn it
const stage = $(".iso-stage");
let drag = null;
stage.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, az: cfg.az, el: cfg.el }; stage.setPointerCapture(e.pointerId); });
stage.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const box = svg.getBoundingClientRect();
  cfg.az = Math.round(Math.min(70, Math.max(25, drag.az - ((e.clientX - drag.x) / box.width) * 90)));
  cfg.el = Math.round(Math.min(50, Math.max(18, drag.el + ((e.clientY - drag.y) / box.height) * 60)));
  document.querySelector('input[data-cfg="az"]').value = cfg.az; document.querySelector('input[data-cfg="el"]').value = cfg.el;
  document.querySelectorAll("input[data-cfg=az], input[data-cfg=el]").forEach((i) => { i.parentElement.querySelector("output").textContent = fmt(cfg[i.dataset.cfg]); });
  buildScene();
});
const endDrag = () => { drag = null; };
stage.addEventListener("pointerup", endDrag);
stage.addEventListener("pointercancel", endDrag);
// theme
const themeBtn = $("[data-theme-toggle]");
const themeRoot = document.querySelector(".iso[data-theme]") || document.body;
const setTheme = (t) => { themeRoot.dataset.theme = t; themeBtn.textContent = t === "dark" ? "Açık tema" : "Koyu tema"; };
const hostTheme = () => document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
setTheme(hostTheme());
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => setTheme(hostTheme()));
new MutationObserver(() => setTheme(hostTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
themeBtn.addEventListener("click", () => setTheme(document.body.dataset.theme === "dark" ? "light" : "dark"));

buildScene();
setPlaying(playing);
report();
`;

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "Quadro 3D yazıcı: tek bir X rayı üzerinde bağımsız hareket eden dört takım kafası, Y yönünde hareket eden ortak bir köprü ve 300 × 300 mm baskı tablası. Aktif kafa baskı yaparken diğerleri sol ve sağdaki park konumlarında bekler; takım değişiminde tüm kafalar aynı anda başlayıp aynı anda durur.",
  body: ['<g data-layer="back"></g>', '<g data-layer="bed"></g>', '<g data-layer="mid"></g>', '<g data-layer="gantry"></g>'],
});

const controls = `
<div class="q-panel">
  <div class="q-row">
    <button data-play aria-pressed="true">Durdur</button>
    <span class="q-label">Sıradaki kafa</span>
    <button data-pick="0">T0</button><button data-pick="1">T1</button><button data-pick="2">T2</button><button data-pick="3">T3</button>
    <button data-clear>İzleri sil</button>
    <button data-theme-toggle>Açık tema</button>
  </div>
  <div class="q-status" data-status></div>
  <p class="q-change" data-change>Takım değişimi bekleniyor…</p>
  <div class="q-row">
    <span class="q-label">Görünüm</span>
    <button data-view="42,30">İzometrik</button><button data-view="65,22">Önden</button><button data-view="28,24">Yandan</button><button data-view="45,50">Yukarıdan</button>
  </div>
  <div class="q-grid">
    <label>Animasyon hızı <output></output><input type="range" data-cfg="scale" min="0.05" max="1" step="0.05"></label>
    <label>Baskı hızı (mm/s) <output></output><input type="range" data-cfg="print" min="30" max="400" step="10"></label>
    <label>X maks. hız (mm/s) <output></output><input type="range" data-cfg="vx" min="100" max="1500" step="50"></label>
    <label>X ivme (mm/s²) <output></output><input type="range" data-cfg="ax" min="500" max="20000" step="500"></label>
    <label>Y tabla maks. hız (mm/s) <output></output><input type="range" data-cfg="vy" min="100" max="1500" step="50"></label>
    <label>Y tabla ivme (mm/s²) <output></output><input type="range" data-cfg="ay" min="500" max="20000" step="500"></label>
    <label>Yatay açı (°) <output></output><input type="range" data-cfg="az" min="25" max="70" step="1"></label>
    <label>Yükseklik açısı (°) <output></output><input type="range" data-cfg="el" min="18" max="50" step="1"></label>
  </div>
</div>`;

const css = `<style>
.iso-stage{touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none}
.iso-stage:active{cursor:grabbing}
.q-trail{fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.q-c0 .iso-top{fill:#3e7bd6}.q-c1 .iso-top{fill:#b9b3a6}.q-c2 .iso-top{fill:#e5484d}.q-c3 .iso-top{fill:#e0a93b}
.q-led{fill:none;stroke-width:2.4;stroke-linecap:round}
[data-spool]>.iso-shade{fill:var(--q-spool);opacity:.85}
.q-panel{margin-top:16px;display:grid;gap:12px;font-size:14px}
.q-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.q-label{color:var(--anatomy-muted);margin:0 4px 0 8px}
.q-panel button{font:inherit;color:var(--anatomy-strong);background:var(--anatomy-card);border:1px solid var(--anatomy-faint);border-radius:8px;padding:8px 14px;min-height:40px;cursor:pointer}
.q-panel button:active{transform:translateY(1px)}
.q-panel button[data-play]{min-width:96px;font-weight:600}
.q-status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.q-head{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;align-items:center;padding:8px 10px;border:1px solid var(--anatomy-faint);border-radius:8px;background:var(--anatomy-card)}
.q-head.is-active{border-color:var(--anatomy-mid)}
.q-head i{width:10px;height:10px;border-radius:50%}
.q-head span,.q-head em{grid-column:2;font-style:normal;color:var(--anatomy-text);font-family:var(--anatomy-mono);font-size:12px}
.q-head b{color:var(--anatomy-strong)}
.q-change{margin:0;color:var(--anatomy-text);font-size:13px;min-height:2.6em}
.q-change b{color:var(--anatomy-strong);font-weight:600}
.q-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px}
.q-grid label{display:grid;grid-template-columns:1fr auto;gap:4px;color:var(--anatomy-text);font-size:13px}
.q-grid output{font-family:var(--anatomy-mono);color:var(--anatomy-strong)}
.q-grid input{grid-column:1 / -1;width:100%;accent-color:var(--anatomy-hi)}
@media (max-width:600px){.q-status{grid-template-columns:repeat(2,minmax(0,1fr))}.q-grid{grid-template-columns:1fr}}
</style>`;

const plate = k.plateHtml({
  fig: "Şekil 1",
  title: "Quadro · 4 bağımsız kafa, tek X kirişi",
  hint: "Sürükle: açıyı çevir",
  readout: "hazır",
  keys: [
    { mark: "lit", label: "Aktif kafa ve nozulu" },
    { mark: "raised", label: "Qdock istasyonları: solda L1–L3, sağda R1–R3" },
  ],
  caption:
    "Tabla Y yönünde ileri geri gider, dört kafa aynı X kirişinde bağımsız hareket eder, kiriş iki dikme üzerinde Z'de yükselir. Kafalar Tool 0→3 sırasıyla durur ve birbirini geçemez: Tool k basarken soldakiler sol Qdock istasyonuna (L1–L3), sağdakiler sağ istasyona (R1–R3) çekilir. Takım değişiminde dört kafa ve tabla aynı ölçeklenmiş trapez profilini kullanır, hepsi aynı anda başlar ve durur; iki kafa arasındaki boşluk doğrusal değiştiği için çarpışma olmaz. Hız ve ivme sınırları varsayımdır, gerçek Quadro algoritması değildir. Ölçüler fotoğraflardan tahmindir; motorlar, kayışlar, kablolar ve Z hareketi çizilmedi.",
  body: `<div class="iso-stage" tabindex="0" role="img" aria-label="Quadro mekanizması">${svg}</div>`,
});

const html = k.pageHtml({ title: "Quadro mekanizması", theme: "dark", body: css + plate + controls, script: kitScript() + live, width: 900 });
writeFileSync(join(HERE, "quadro.html"), html);

// Artifact version: no document skeleton, theme follows the viewer.
const artifact = `<title>Quadro Mekanizması</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root{--q-page:#f2f2ef}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--q-page:#0b0b0b;color-scheme:dark}}
:root[data-theme="dark"]{--q-page:#0b0b0b;color-scheme:dark}
body{background:var(--q-page)}
${k.ISO_CSS}
*{box-sizing:border-box}
.q-page{background:var(--anatomy-page);color:var(--anatomy-text);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;padding-block:32px 64px;padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px))}
.q-page main{max-width:900px;margin:0 auto}
</style>
${css}
<div class="iso q-page" data-theme="dark"><main>${plate}${controls}</main></div>
<script type="module">${(kitScript() + live).replace(/<\/(script)/gi, "<\\/$1")}</script>
`;
writeFileSync(join(HERE, "quadro-artifact.html"), artifact);
console.log("wrote quadro/quadro.html", (html.length / 1024).toFixed(0) + " KB");

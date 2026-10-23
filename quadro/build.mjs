// Quadro: four independent toolheads on one X rail, a moving Y gantry, synchronised toolchange moves.
// Build: node quadro/build.mjs  ->  quadro/quadro.html (standalone, no dependencies)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../.claude/skills/anatomy/kit/iso-kit.mjs";
import { kitScript } from "../.claude/skills/anatomy/scripts/inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDTH = 900;
const HEIGHT = 560;

// Everything below runs in the page: the scene is rebuilt from world geometry whenever the camera changes.
const live = String.raw`
const W = ${WIDTH}, H = ${HEIGHT};
const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#3e63dd"];

// ---- world, in millimetres: x along the X rail, y front-back, z up ----
const BASE = { x: -320, y: -180, w: 960, d: 610, r: 16 }, BASE_H = 36, FOOT_H = 14;
const RAILS = [-262, 582];
const RAIL_Y0 = -125, RAIL_Y1 = 320;
const BED_TOP = 112;
const NOZ_DY = 72;                       // nozzle sits 72 mm in front of the beam centre
const BEAM = { x: -296, y: -28, w: 912, d: 56, r: 4 }, BEAM_Z0 = 330, BEAM_Z1 = 390;
const HEAD_W = 55;
const LP = [-174, -116, -58];            // left park slots L1, L2, L3 (heads 1, 2, 3)
const RP = [358, 416, 474];              // right park slots R1, R2, R3 (heads 2, 3, 4)

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
function baseSvg() {
  const out = ['<path class="iso-halo" d="' + haloOf(BASE, -BASE_H - FOOT_H, BASE_H, P) + '"/>'];
  out.push(byDepth(corners(BASE, 44).map(([x, y]) => ({
    depth: depthOf([x, y, 0], P),
    svg: S(cylinder(x, y, 24, -BASE_H - FOOT_H, 4, P, 32), { tone: "lo" }) + S(cylinder(x, y, 18, -BASE_H - FOOT_H + 4, FOOT_H - 4, P, 32), { tone: "mid" }),
  }))));
  out.push(S(slabOf(BASE, -BASE_H, BASE_H, P, 10, 3), { tone: "mid", inner: Ln(sideSeam(BASE, -14, P, 10), { tone: "faint" }) }));
  out.push(Ln(planOutline(insetPlan(BASE, 14), 0, P, 10), { tone: "lo" }));
  const screws = corners(BASE, 26);
  out.push(Ln(screws.map(([x, y]) => ring(x, y, 7, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(Dt(screws.map(([x, y]) => at([x, y, 0])), { size: 0.55 }));
  // X ruler under the bed: 0 to 300 mm
  const strip = { x: -14, y: 336, w: 328, d: 18, r: 2 };
  out.push(S(slabOf(strip, 0, 1.5, P, 3), { tone: "lo", crease: "none" }));
  const t = topTicks(0, 300, 10, 5, strip.y + 2, 1.5, [6, 12], P);
  out.push(Ln(t.minor, { tone: "lo" }), Ln(t.major, { tone: "mid" }));
  out.push(Dt([at([strip.x + 5, strip.y + 9, 1.5]), at([strip.x + strip.w - 5, strip.y + 9, 1.5])], { size: 0.45 }));
  // name plate
  const plate = { x: 400, y: 352, w: 170, d: 46, r: 3 };
  out.push(S(slabOf(plate, 0, 1.5, P, 3, 0.6), { tone: "lo", crease: "none" }));
  out.push(faceTextSvg(topMatrix([plate.x + plate.w / 2, plate.y + 29], 1.5, P, "x"), "QUADRO", { size: 17, tone: "mid", anchor: "middle" }));
  out.push(Dt(corners(plate, 6).map(([x, y]) => at([x, y, 1.5])), { size: 0.45 }));
  return out.join("");
}

function railSvg(rx) {
  const out = [];
  const motor = { x: rx - 21, y: RAIL_Y0 - 46, w: 42, d: 42, r: 3 };
  out.push(S(slabOf(motor, 0, 42, P, 4, 1), { tone: "mid", inner: Ln(sideSeam(motor, 12, P, 4), { tone: "faint" }) + Ln(sideSeam(motor, 30, P, 4), { tone: "faint" }) }));
  out.push(Dt(corners(motor, 5).map(([x, y]) => at([x, y, 42])), { size: 0.45 }));
  out.push(S(cylinder(rx, motor.y + 21, 9, 42, 3, P, 24), { tone: "lo" }));
  out.push(S(cylinder(rx, motor.y + 21, 3, 45, 8, P, 16), { tone: "mid" }));
  const bedPlan = { x: rx - 26, y: RAIL_Y0, w: 52, d: RAIL_Y1 - RAIL_Y0, r: 3 };
  out.push(S(slabOf(bedPlan, 0, 8, P, 3, 1), { tone: "mid" }));
  const railPlan = { x: rx - 9, y: RAIL_Y0 + 8, w: 18, d: RAIL_Y1 - RAIL_Y0 - 26, r: 1.5 };
  out.push(S(slabOf(railPlan, 8, 14, P, 3, 0.8), { tone: "mid" }));
  const bolts = [];
  for (let y = RAIL_Y0 + 30; y < RAIL_Y1 - 20; y += 60) bolts.push(at([rx, y, 22]));
  out.push(Dt(bolts, { size: 0.45, tone: "lo" }));
  out.push(S(slabOf({ x: rx - 16, y: RAIL_Y1 - 16, w: 32, d: 10, r: 1.5 }, 8, 20, P, 3, 0.6), { tone: "mid" }));
  return out.join("");
}

function bedSvg() {
  const items = [];
  const ped = { x: 60, y: 60, w: 180, d: 180, r: 8 };
  items.push({ depth: depthOf([150, 150, 0], P), svg: S(slabOf(ped, 0, 76, P, 6, 1.2), { tone: "mid", inner: Ln(sideSeam(ped, 26, P, 6), { tone: "faint" }) }) + Ln(planOutline(insetPlan(ped, 12), 76, P, 6), { tone: "faint" }) });
  for (const [x, y] of [[22, 22], [278, 22], [22, 278], [278, 278]]) {
    items.push({ depth: depthOf([x, y, 0], P), svg: S(cylinder(x, y, 13, 0, 6, P, 24), { tone: "lo" }) + S(cylinder(x, y, 6, 6, 86, P, 20), { tone: "mid", crease: "none" }) });
  }
  const carrier = { x: -12, y: -12, w: 324, d: 324, r: 10 };
  const plate = { x: 0, y: 0, w: 300, d: 300, r: 4 };
  let grid = "";
  for (let v = 50; v < 300; v += 50) grid += lineOnTop([v, 0], [v, 300], BED_TOP, P) + lineOnTop([0, v], [300, v], BED_TOP, P);
  return byDepth(items)
    + S(slabOf(carrier, 92, 12, P, 6, 1.2), { tone: "mid" })
    + Dt(corners(carrier, 6).map(([x, y]) => at([x, y, 104])), { size: 0.45 })
    + S(slabOf(plate, 104, 8, P, 4, 1), { tone: "mid" })
    + Ln(grid, { tone: "faint" })
    + Ln(planOutline(insetPlan(plate, 4), BED_TOP, P, 4), { tone: "lo" });
}

function gantrySvg() {
  const out = [];
  for (const rx of RAILS) {
    const block = { x: rx - 30, y: -42, w: 60, d: 84, r: 4 };
    out.push(S(slabOf(block, 22, 18, P, 4, 1), { tone: "mid" }));
    out.push(Dt(corners(block, 7).map(([x, y]) => at([x, y, 40])), { size: 0.45 }));
    const post = { x: rx - 20, y: -26, w: 40, d: 52, r: 3 };
    out.push(S(slabOf(post, 40, BEAM_Z0 - 40, P, 4, 1), { tone: "mid", inner: Ln(sideSeam(post, 185, P, 4), { tone: "faint" }) }));
  }
  out.push(S(slabOf(BEAM, BEAM_Z0, BEAM_Z1 - BEAM_Z0, P, 4, 2), { tone: "mid", inner: Ln(sideSeam(BEAM, 352, P, 4), { tone: "faint" }) }));
  // X rail on the beam front face
  out.push(S(slabOf({ x: -280, y: 28, w: 880, d: 8, r: 1 }, 354, 18, P, 2, 0.6), { tone: "mid" }));
  // ruler on top of the beam, with park slots and the print range outlined
  const strip = { x: -286, y: -24, w: 892, d: 14, r: 2 };
  out.push(S(slabOf(strip, BEAM_Z1, 1.5, P, 3), { tone: "lo", crease: "none" }));
  const t = topTicks(-280, 600, 10, 5, strip.y + 2, BEAM_Z1 + 1.5, [5, 10], P);
  out.push(Ln(t.minor, { tone: "lo" }), Ln(t.major, { tone: "mid" }));
  const slot = (cx) => planOutline({ x: cx - HEAD_W / 2, y: -6, w: HEAD_W, d: 26, r: 3 }, BEAM_Z1, P, 3);
  out.push(Ln([...LP, ...RP].map(slot).join(""), { tone: "lo" }));
  out.push(Ln(planOutline({ x: 0, y: -6, w: 300, d: 26, r: 3 }, BEAM_Z1, P, 3), { tone: "mid" }));
  out.push(Dt([...LP, ...RP].map((cx) => at([cx, 7, BEAM_Z1])), { size: 0.5, tone: "lo" }));
  return out.join("");
}

function headSvg(j) {
  const lit = j === active;
  const o = [];
  const car = { x: -HEAD_W / 2, y: 36, w: HEAD_W, d: 10, r: 2 };
  o.push(S(slabOf(car, 318, 70, P, 3, 0.8), { tone: "mid" }));
  o.push(Dt([[-20, 378], [20, 378], [-20, 328], [20, 328]].map(([x, z]) => at([x, 46, z])), { size: 0.45 }));
  const hood = { x: -26, y: 46, w: 52, d: 50, r: 5 };
  o.push(S(slabOf(hood, 196, 122, P, 5, 1), { tone: lit ? "hi" : "mid", crease: lit ? "lo" : "faint", inner: Ln(sideSeam(hood, 236, P, 5), { tone: "faint" }) }));
  o.push(S(slabOf({ x: -12, y: 70, w: 24, d: 18, r: 2 }, 318, 3, P, 3), { tone: "mid", className: "q-c" + j }));
  o.push(S(cylinder(0, 58, 4, 318, 14, P, 16), { tone: "mid" }));
  // fan on the front face
  const fan = [0, 96, 276];
  let blades = "";
  for (let b = 0; b < 7; b++) {
    const a = (b / 7) * Math.PI * 2;
    blades += segment([Math.cos(a) * 4.5, 96, fan[2] + Math.sin(a) * 4.5], [Math.cos(a + 0.5) * 14, 96, fan[2] + Math.sin(a + 0.5) * 14], P);
  }
  o.push(Ln(sideRing(fan, 18, "y", P, 32), { tone: "lo" }), Ln(sideRing(fan, 14, "y", P, 32), { tone: "lo" }), Ln(blades, { tone: "faint" }), Ln(sideRing(fan, 4.5, "y", P, 16), { tone: "mid" }));
  o.push(Dt([[-15, 291], [15, 291], [-15, 261], [15, 261]].map(([x, z]) => at([x, 96, z])), { size: 0.4 }));
  o.push(faceTextSvg(sideMatrix([0, 96], 222, P, "left"), "T" + (j + 1), { size: 14, tone: lit ? "hi" : "mid", anchor: "middle" }));
  // hot end: ducts either side, heatsink, heater block, nozzle
  o.push(S(slabOf({ x: -24, y: 58, w: 8, d: 30, r: 1.5 }, 142, 54, P, 2), { tone: "mid" }));
  o.push(S(cylinder(0, 72, 10, 160, 36, P, 28), { tone: "mid", inner: Ln([166, 172, 178, 184, 190].map((z) => sideArc(0, 72, 10, z, P, 20)).join(""), { tone: "faint" }) }));
  o.push(S(slabOf({ x: -12, y: 62, w: 24, d: 20, r: 1.5 }, 132, 28, P, 2, 0.5), { tone: "mid" }));
  o.push(S(cylinder(0, 72, 5, 122, 10, P, 16), { tone: "hi", lit }));
  o.push(S(cylinder(0, 72, 2.2, BED_TOP + 2, 8, P, 12), { tone: "hi", lit }));
  o.push(S(slabOf({ x: 16, y: 58, w: 8, d: 30, r: 1.5 }, 142, 54, P, 2), { tone: "mid" }));
  return o.join("");
}

// ================= scene =================
const svg = document.querySelector(".iso-stage svg");
const layer = (name) => svg.querySelector('[data-layer="' + name + '"]');
function fitView() {
  const pts = [...boxCorners(BASE, -BASE_H - FOOT_H, 0)];
  for (const gy of [-NOZ_DY, 300 - NOZ_DY]) pts.push(...boxCorners({ x: BEAM.x, y: gy + BEAM.y, w: BEAM.w, d: BEAM.d + 70, r: 0 }, 0, BEAM_Z1 + 2));
  P = fitProjection(pts, W, H, { pad: 14, azimuth: cfg.az, elevation: cfg.el });
}
function buildScene() {
  fitView();
  layer("back").innerHTML = baseSvg() + railSvg(RAILS[0]) + bedSvg() + railSvg(RAILS[1]);
  layer("trails").innerHTML = trails.map((t) => '<path class="q-trail" stroke="' + COLORS[t.c] + '" d=""/>').join("");
  trails.forEach((t, i) => { t.el = layer("trails").children[i]; t.dirty = true; });
  layer("gantry").innerHTML = gantrySvg() + [0, 1, 2, 3].map((j) => '<g data-head="' + j + '">' + headSvg(j) + "</g>").join("");
  draw();
}
function draw() {
  layer("gantry").setAttribute("transform", translateAlong(P, [0, ny - NOZ_DY, 0]));
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
  const names = ["T1", "T2", "T3", "T4", "Y"];
  const moves = axes.map((ax, i) => (Math.abs(ax.d) < 0.5 ? null : names[i] + " " + (ax.d > 0 ? "+" : "") + fmt(ax.d) + " mm (tepe " + fmt(phase.peaks[i]) + " mm/s)")).filter(Boolean);
  changeEl.innerHTML = "<b>Son eşzamanlı hareket: " + (phase.prev < 0 ? "başlangıç" : "T" + (phase.prev + 1)) + " → T" + (next + 1) + " · " + fmt(T, 2) + " s</b><br>" + moves.join(" · ");
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
  for (let i = 0; i < 3; i++) { if (near(LP[i])) return "park L" + (i + 1); if (near(RP[i])) return "park R" + (i + 1); }
  return null;
}
function report() {
  let text;
  if (phase.kind === "change") text = "Takım değişimi " + (phase.prev < 0 ? "başlangıç" : "T" + (phase.prev + 1)) + " → T" + (phase.next + 1) + " · " + fmt(phase.t, 2) + " / " + fmt(phase.T, 2) + " s";
  else if (phase.kind === "print") text = "T" + (active + 1) + " baskıda · X " + fmt(xs[active]) + " · Y " + fmt(ny) + " mm";
  else text = "hazır";
  if (readout.textContent !== text) readout.textContent = text;
  const rows = xs.map((x, j) => {
    const where = j === active && phase.kind === "print" ? "baskıda" : slotName(j, x) || (phase.kind === "change" ? "hareket" : "—");
    return '<div class="q-head' + (j === active ? " is-active" : "") + '"><i style="background:' + COLORS[j] + '"></i><b>T' + (j + 1) + "</b><span>" + where + "</span><em>X " + fmt(x) + "</em></div>";
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
  body: ['<g data-layer="back"></g>', '<g data-layer="trails"></g>', '<g data-layer="gantry"></g>'],
});

const controls = `
<div class="q-panel">
  <div class="q-row">
    <button data-play aria-pressed="true">Durdur</button>
    <span class="q-label">Sıradaki kafa</span>
    <button data-pick="0">T1</button><button data-pick="1">T2</button><button data-pick="2">T3</button><button data-pick="3">T4</button>
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
    <label>Y maks. hız (mm/s) <output></output><input type="range" data-cfg="vy" min="100" max="1500" step="50"></label>
    <label>Y ivme (mm/s²) <output></output><input type="range" data-cfg="ay" min="500" max="20000" step="500"></label>
    <label>Yatay açı (°) <output></output><input type="range" data-cfg="az" min="25" max="70" step="1"></label>
    <label>Yükseklik açısı (°) <output></output><input type="range" data-cfg="el" min="18" max="50" step="1"></label>
  </div>
</div>`;

const css = `<style>
.iso-stage{touch-action:pan-y;cursor:grab;user-select:none;-webkit-user-select:none}
.iso-stage:active{cursor:grabbing}
.q-trail{fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}
.q-c0 .iso-top{fill:#e5484d}.q-c1 .iso-top{fill:#f5a524}.q-c2 .iso-top{fill:#30a46c}.q-c3 .iso-top{fill:#3e63dd}
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
  title: "Quadro · 4 kafa, tek X ekseni",
  hint: "Sürükle: açıyı çevir",
  readout: "hazır",
  keys: [
    { mark: "lit", label: "Aktif kafa ve nozulu" },
    { mark: "raised", label: "Park konumları: kirişin üstünde L1–L3 ve R1–R3" },
  ],
  caption:
    "Kafalar 1→4 sırasıyla aynı rayda durur ve birbirini geçemez: T(k) basarken soldakiler L park yuvalarına, sağdakiler R yuvalarına çekilir. Takım değişiminde her eksen (4 kafa ve Y köprüsü) aynı ölçeklenmiş trapez profilini kullanır, bu yüzden hepsi aynı anda başlar ve aynı anda durur. İki kafa arasındaki boşluk başlangıç ve bitiş değerleri arasında doğrusal değiştiği için hareket sırasında kafalar çarpışmaz. Hız ve ivme sınırları varsayımdır; gerçek Quadro algoritması değildir. Tahrik (kayış/motor) ve Z ekseni modellenmedi.",
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

// Kickstarter Live — tiny zero-dependency server.
// Serves ./public and proxies Kickstarter's public stats.json (which has no CORS headers,
// so a browser cannot read it directly).
//
//   node server.js            -> http://localhost:3000
//   PORT=8080 node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, "public");
const CACHE_MS = 4000; // Kickstarter itself caches stats.json for 5 s

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const cache = new Map(); // project -> { at, status, body }

// "creator/slug" only — keeps the proxy from being used for anything else.
const PROJECT_RE = /^[A-Za-z0-9_-]{1,80}\/[A-Za-z0-9_-]{1,120}$/;

async function fetchStats(project) {
  const hit = cache.get(project);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;

  const url = `https://www.kickstarter.com/projects/${project}/stats.json?v=1`;
  let entry;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (kickstarter-live dashboard)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    entry = { at: Date.now(), status: res.status, body: res.ok ? text : JSON.stringify({ error: `kickstarter ${res.status}` }) };
  } catch (err) {
    entry = { at: Date.now(), status: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
  cache.set(project, entry);
  return entry;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/stats") {
    const project = (url.searchParams.get("project") || "").trim();
    if (!PROJECT_RE.test(project)) return send(res, 400, JSON.stringify({ error: "project must look like creator/slug" }));
    const r = await fetchStats(project);
    return send(res, r.status, r.body);
  }

  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
  if (url.pathname.endsWith("/")) file = path.join(file, "index.html");

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found", "text/plain");
    send(res, 200, data, TYPES[path.extname(file)] || "application/octet-stream");
  });
});

server.listen(PORT, () => {
  console.log(`Kickstarter Live → http://localhost:${PORT}`);
  console.log(`Demo (test)      → http://localhost:${PORT}/?demo=1`);
  // addresses a TV / phone on the same Wi-Fi can open
  for (const list of Object.values(require("os").networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) console.log(`Aynı ağdan (TV)  → http://${a.address}:${PORT}`);
    }
  }
});

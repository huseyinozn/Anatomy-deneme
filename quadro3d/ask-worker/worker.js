// Cloudflare Worker behind the "Ask about Quadro" box on the Quadro 3D page.
// The page posts { question, history, state }; the worker asks Claude with the API key kept as the
// ANTHROPIC_API_KEY secret and returns { answer }.
// Everything that may change (system prompt, model, limits, allowed sites) lives in ask-config.json, published next
// to the page on GitHub Pages and re-read every few minutes, so updating the assistant never means redeploying this.
const CONFIG_URL = "https://huseyinozn.github.io/quadro-3d/ask-config.json";
const DEFAULTS = {
  model: "claude-haiku-5-5", max_tokens: 1500, thinking: { type: "disabled" }, max_question: 600, max_turns: 6, per_ip_per_hour: 20,
  origins: ["https://huseyinozn.github.io", "null"],
  system: "You are the assistant on the interactive 3D page of the Co Print Quadro 3D printer. Answer briefly in the language of the question; never invent facts.",
};

let config = DEFAULTS, loadedAt = 0;
async function getConfig() {
  if (Date.now() - loadedAt < 5 * 60 * 1000) return config;
  try {
    const res = await fetch(CONFIG_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (res.ok) config = { ...DEFAULTS, ...(await res.json()) };
  } catch {}
  loadedAt = Date.now();
  return config;
}

const hits = new Map();
function limited(ip, limit) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  h.push(now); hits.set(ip, h);
  return h.length > limit;
}

export default {
  async fetch(req, env) {
    const cfg = await getConfig();
    const origin = req.headers.get("Origin") || "";
    const allowed = cfg.origins.includes(origin);
    const cors = { "Access-Control-Allow-Origin": allowed ? origin : cfg.origins[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || !allowed) return reply({ error: "forbidden" }, 403);
    if (limited(req.headers.get("CF-Connecting-IP") || "?", cfg.per_ip_per_hour)) return reply({ error: "Too many questions, try again later." }, 429);

    let body;
    try { body = await req.json(); } catch { return reply({ error: "bad request" }, 400); }
    const question = String(body.question || "").trim().slice(0, cfg.max_question);
    if (!question) return reply({ error: "empty question" }, 400);
    const history = (Array.isArray(body.history) ? body.history : []).slice(-cfg.max_turns * 2)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    while (history.length && history[0].role !== "user") history.shift();
    if (history.length && history[history.length - 1].role === "user") history.pop();
    const state = typeof body.state === "string" ? body.state.slice(0, 800) : "";

    const request = {
      model: cfg.model, max_tokens: cfg.max_tokens,
      system: cfg.system + (state ? "\n\nCurrent state of the simulation on the visitor's screen:\n" + state : ""),
      messages: [...history, { role: "user", content: question }],
    };
    if (cfg.thinking) request.thinking = cfg.thinking;
    if (cfg.effort) request.output_config = { effort: cfg.effort };
    const call = () => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    // one retry after a short pause when the API is busy (429 rate limit, 529 overloaded, other 5xx)
    let res = await call();
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1500)); res = await call(); }
    if (!res.ok) return reply({ error: "The assistant is unavailable right now (" + res.status + "), please try again.", detail: (await res.text()).slice(0, 300) }, 502);
    const data = await res.json();
    // stop says why an answer ended (end_turn when complete); a cut answer is marked with "…"
    const answer = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const cut = data.stop_reason && data.stop_reason !== "end_turn";
    return reply({ answer: cut ? answer + " …" : answer, stop: data.stop_reason, tokens: data.usage && data.usage.output_tokens, version: 2 });
  },
};

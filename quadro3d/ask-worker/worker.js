// Cloudflare Worker behind the "Ask about Quadro" box on the Quadro 3D page.
// The page posts { question, history, state }; the worker asks Claude with the API key kept as the
// ANTHROPIC_API_KEY secret and returns { answer }. Only the listed origins may call it.
const ORIGINS = ["https://huseyinozn.github.io", "null"];   // "null": the single-file copy opened from disk
const MODEL = "claude-haiku-5-5", MAX_TOKENS = 1500, MAX_QUESTION = 600, MAX_TURNS = 6;
const PER_IP = { limit: 20, windowMs: 60 * 60 * 1000 };       // questions per visitor per hour (per worker instance)

const SYSTEM = `You are the assistant on the interactive 3D page of the Co Print Quadro, a desktop 3D printer.
Answer questions about the printer and about the page. Be short (about 120 words at most), friendly and concrete; reply in the language of the question.

What you know about Quadro:
- Four independent toolheads (T0 to T3) on one shared X beam. Each has its own X carriage, so a toolchange is a
  parallel move of carriages, not a tool swap: the arriving tool drives to the part while the others make room.
- Idle heads park in Qdock stations at both ends of the beam (three slots per side); spring-loaded silicone
  nozzle closers seal a parked nozzle.
- Firmware is Klipper with Co Print's own modules: QUADRO_PARALLEL_MOVE (synchronized multi-carriage moves),
  bed pin calibration (per-tool offsets measured with a load cell on a pin in the bed), axis slip test,
  Quadro custom bed mesh, per-carriage input shaper calibration, toolhead LEDs.
- Motion limits in the config: 500 mm/s max velocity, 10000 mm/s² max acceleration; toolchanges run at 350 mm/s
  and 7000 mm/s². A purge tower at the back left of the bed primes each tool after a change.

About the page: the model is built from the production CAD. The console runs the printer's real Klipper
configuration in a simulation (G28, T0-T3, "T1 X=250", QUADRO_PARALLEL_MOVE, BED_PIN_CALIBRATE_TOOL, HELP ...).
Load cell forces and accelerometer data are not simulated. "Clear bed" removes the printed part.
You may suggest console commands the visitor can try.

Never invent facts. For price, release date, shipping, build volume or anything not listed above, say you do not
have that information and point to Co Print (coprint3d.com). Decline unrelated requests politely.`;

const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < PER_IP.windowMs);
  h.push(now); hits.set(ip, h);
  return h.length > PER_IP.limit;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || !ORIGINS.includes(origin)) return reply({ error: "forbidden" }, 403);
    if (limited(req.headers.get("CF-Connecting-IP") || "?")) return reply({ error: "Too many questions, try again later." }, 429);

    let body;
    try { body = await req.json(); } catch { return reply({ error: "bad request" }, 400); }
    const question = String(body.question || "").trim().slice(0, MAX_QUESTION);
    if (!question) return reply({ error: "empty question" }, 400);
    const history = (Array.isArray(body.history) ? body.history : []).slice(-MAX_TURNS * 2)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    while (history.length && history[0].role !== "user") history.shift();
    if (history.length && history[history.length - 1].role === "user") history.pop();
    const state = typeof body.state === "string" ? body.state.slice(0, 800) : "";

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        // Haiku 5.5 thinks by default and its thinking eats into max_tokens, cutting answers off at random;
        // short product answers don't need it
        model: MODEL, max_tokens: MAX_TOKENS, thinking: { type: "disabled" },
        system: SYSTEM + (state ? "\n\nCurrent state of the simulation on the visitor's screen:\n" + state : ""),
        messages: [...history, { role: "user", content: question }],
      }),
    });
    if (!res.ok) return reply({ error: "The assistant is unavailable right now." }, 502);
    const data = await res.json();
    const answer = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    // stop and tokens say why an answer ended (end_turn when complete); a cut answer is marked with "…"
    const cut = data.stop_reason && data.stop_reason !== "end_turn";
    return reply({ answer: cut ? answer + " …" : answer, stop: data.stop_reason, tokens: data.usage && data.usage.output_tokens, blocks: (data.content || []).map((c) => c.type) });
  },
};

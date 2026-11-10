(() => {
  "use strict";

  // ── config ────────────────────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo");
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  const cfg = Object.assign(
    { project: "", title: "Kickstarter Live", goal: 10000, currency: "$", launchAt: null, endAt: null, pollSeconds: 10, maxChimes: 5 },
    window.CAMPAIGN || {},
    store.get("ksl:overrides", {})
  );
  if (params.get("project")) cfg.project = params.get("project");
  cfg.project = normalizeProject(cfg.project);

  function normalizeProject(s) {
    if (!s) return "";
    s = String(s).trim().replace(/^https?:\/\/(www\.)?kickstarter\.com/i, "").replace(/[?#].*$/, "");
    const m = s.match(/(?:^|\/)projects\/([^/]+)\/([^/]+)/) || s.match(/^\/?([^/]+)\/([^/]+)/);
    return m ? `${m[1]}/${m[2]}` : "";
  }

  // ── dom ───────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    gate: $("gate"), gateBtn: $("gateBtn"), title: $("title"), status: $("status"),
    pre: $("pre"), live: $("live"), countdown: $("countdown"), launchText: $("launchText"),
    barFill: $("barFill"), pledged: $("pledged"), goalText: $("goalText"),
    backers: $("backers"), percent: $("percent"), daysBox: $("daysBox"), days: $("days"), daysLabel: $("daysLabel"),
    feed: $("feed"), toasts: $("toasts"), chime: $("chime"),
    soundBtn: $("soundBtn"), testBtn: $("testBtn"), fsBtn: $("fsBtn"), cfgBtn: $("cfgBtn"), cfg: $("cfg"),
  };

  const fmtMoney = (n) => cfg.currency + Math.round(n).toLocaleString("en-US");
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const fmtTime = (t) => new Date(t).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  el.title.textContent = cfg.title + (DEMO ? " · DEMO" : "");
  document.title = cfg.title;

  // ── sound ─────────────────────────────────────────────────────────────────
  let soundOn = store.get("ksl:sound", true);
  let chimeQueue = 0, chiming = false;

  function renderSoundBtn() {
    el.soundBtn.textContent = soundOn ? "🔊 Ses açık" : "🔇 Ses kapalı";
    el.soundBtn.classList.toggle("off", !soundOn);
  }
  function chime(times = 1) {
    if (!soundOn) return;
    chimeQueue = Math.min(chimeQueue + times, cfg.maxChimes);
    if (!chiming) nextChime();
  }
  function nextChime() {
    if (chimeQueue <= 0) { chiming = false; return; }
    chiming = true; chimeQueue--;
    // reuse the element unlocked by the click (Safari only allows that one)
    const a = el.chime.paused ? el.chime : el.chime.cloneNode();
    a.currentTime = 0;
    a.play().catch(() => {});
    setTimeout(nextChime, 1100);
  }

  // ── animated numbers ──────────────────────────────────────────────────────
  const shown = { pledged: 0, backers: 0, percent: 0 };
  function animateTo(key, node, target, fmt) {
    const from = shown[key];
    if (from === target) { node.textContent = fmt(target); return; }
    const t0 = performance.now(), dur = 1200;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(from + (target - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    shown[key] = target;
    requestAnimationFrame(step);
  }
  function bump(node) { node.classList.remove("bump"); void node.offsetWidth; node.classList.add("bump"); }

  // ── render ────────────────────────────────────────────────────────────────
  function renderStats(s, animate) {
    const pct = cfg.goal > 0 ? (s.pledged / cfg.goal) * 100 : 0;
    const f = animate ? animateTo : (k, n, v, fm) => { shown[k] = v; n.textContent = fm(v); };
    f("pledged", el.pledged, s.pledged, fmtMoney);
    f("backers", el.backers, s.backers, fmtInt);
    f("percent", el.percent, pct, (v) => Math.floor(v) + "%");
    el.barFill.style.width = Math.min(100, pct) + "%";
    el.goalText.textContent = `pledged of ${fmtMoney(cfg.goal)} goal`;
    renderDays(s.state);
  }

  function renderDays(state) {
    if (!cfg.endAt) { el.daysBox.hidden = true; return; }
    el.daysBox.hidden = false;
    const ms = new Date(cfg.endAt) - Date.now();
    if (ms <= 0 || (state && state !== "live")) { el.days.textContent = "0"; el.daysLabel.textContent = "days to go"; return; }
    const h = ms / 3.6e6;
    if (h >= 48) { el.days.textContent = Math.floor(h / 24); el.daysLabel.textContent = "days to go"; }
    else { el.days.textContent = Math.max(1, Math.floor(h)); el.daysLabel.textContent = "hours to go"; }
  }

  function showMode(mode) { // "pre" | "live"
    el.pre.hidden = mode !== "pre";
    el.live.hidden = mode !== "live";
  }

  function setStatus(kind, text) {
    el.status.className = "status " + kind;
    el.status.querySelector("span").textContent = text;
  }

  // countdown
  function tickCountdown() {
    if (!cfg.launchAt) return;
    const ms = Math.max(0, new Date(cfg.launchAt) - Date.now());
    const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
    const set = (k, v) => (el.countdown.querySelector(`[data-k="${k}"]`).textContent = v);
    set("d", d); set("h", String(h).padStart(2, "0")); set("m", String(m).padStart(2, "0")); set("s", String(s).padStart(2, "0"));
  }
  if (cfg.launchAt) {
    el.launchText.textContent = new Date(cfg.launchAt).toLocaleString("tr-TR", { dateStyle: "full", timeStyle: "short" });
  }

  // feed
  let feed = store.get(`ksl:feed:${DEMO ? "demo" : cfg.project}`, []);
  function renderFeed(newest) {
    if (!feed.length) return;
    el.feed.innerHTML = "";
    feed.forEach((it, i) => {
      const li = document.createElement("li");
      if (i === 0 && newest) li.className = "new";
      const who = it.backers > 1 ? `+${it.backers} backers` : it.backers === 1 ? "+1 backer" : "Destek artırıldı";
      li.innerHTML = `<span>${who}</span><span class="amt">+${fmtMoney(it.amount)}</span><span class="t">${fmtTime(it.at)}</span>`;
      el.feed.appendChild(li);
    });
  }
  function toast(text) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = text;
    el.toasts.prepend(t);
    setTimeout(() => t.remove(), 5200);
  }

  // ── change detection ──────────────────────────────────────────────────────
  const lastKey = `ksl:last:${DEMO ? "demo" : cfg.project}`;
  let last = null; // first fetch after load = silent baseline

  function onStats(s) {
    showMode("live");
    if (!last) {
      renderStats(s, false);
      last = s; store.set(lastKey, s);
      return;
    }
    const dB = s.backers - last.backers;
    const dP = s.pledged - last.pledged;
    if (dB > 0 || dP > 0.5) {
      const label = dB > 1 ? `+${dB} backers` : dB === 1 ? "+1 backer" : "Destek artırıldı";
      toast(`🎉 ${label} · +${fmtMoney(Math.max(0, dP))}`);
      chime(dB > 0 ? dB : 1);
      feed.unshift({ backers: Math.max(0, dB), amount: Math.max(0, dP), at: Date.now() });
      feed = feed.slice(0, 15);
      store.set(`ksl:feed:${DEMO ? "demo" : cfg.project}`, feed);
      renderFeed(true);
      if (dB > 0) bump(el.backers);
      bump(el.pledged);
    }
    renderStats(s, true);
    last = s; store.set(lastKey, s);
  }

  // ── polling ───────────────────────────────────────────────────────────────
  async function poll() {
    if (!cfg.project) {
      setStatus("err", "Proje linki ayarlanmadı (⚙ Ayarlar)");
      showMode("pre");
      return;
    }
    try {
      const res = await fetch(`/api/stats?project=${encodeURIComponent(cfg.project)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      const p = data.project;
      if (!res.ok || !p) {
        const before = cfg.launchAt && Date.now() < new Date(cfg.launchAt);
        setStatus(before ? "" : "err", before ? "Lansman bekleniyor" : `Veri alınamadı (${res.status})`);
        if (!last) showMode("pre");
        return;
      }
      if (p.state !== "live" && !last && (p.state === "submitted" || p.state === "started" || p.state === "draft")) {
        setStatus("", "Lansman bekleniyor");
        showMode("pre");
        return;
      }
      onStats({ backers: Number(p.backers_count) || 0, pledged: parseFloat(p.pledged) || 0, state: p.state });
      setStatus(p.state === "live" ? "ok" : "", (p.state === "live" ? "Canlı" : p.state) + " · " + fmtTime(Date.now()));
    } catch (e) {
      setStatus("err", "Bağlantı yok — tekrar deneniyor");
    }
  }

  // demo: random backers every few seconds
  function startDemo() {
    const s = { backers: 0, pledged: 0, state: "live" };
    onStats({ ...s });
    setStatus("ok", "Demo modu");
    const tick = () => {
      const n = Math.random() < 0.85 ? 1 : 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) { s.backers++; s.pledged += [39, 49, 79, 99, 149, 249][Math.floor(Math.random() * 6)]; }
      onStats({ ...s });
      setTimeout(tick, 4000 + Math.random() * 8000);
    };
    setTimeout(tick, 3000);
  }

  // ── controls ──────────────────────────────────────────────────────────────
  el.soundBtn.onclick = () => { soundOn = !soundOn; store.set("ksl:sound", soundOn); renderSoundBtn(); };
  el.testBtn.onclick = () => { const was = soundOn; soundOn = true; chime(1); soundOn = was; toast("🔔 Test: ses çalışıyor"); };
  el.fsBtn.onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  el.cfgBtn.onclick = () => {
    const f = el.cfg.querySelector("form");
    f.project.value = cfg.project ? `https://www.kickstarter.com/projects/${cfg.project}` : "";
    f.goal.value = cfg.goal;
    f.endAt.value = cfg.endAt ? toLocalInput(cfg.endAt) : "";
    el.cfg.showModal();
  };
  el.cfg.addEventListener("close", () => {
    if (el.cfg.returnValue !== "save") return;
    const f = el.cfg.querySelector("form");
    const o = store.get("ksl:overrides", {});
    o.project = normalizeProject(f.project.value);
    o.goal = Number(f.goal.value) || cfg.goal;
    o.endAt = f.endAt.value ? new Date(f.endAt.value).toISOString() : null;
    store.set("ksl:overrides", o);
    location.reload();
  });
  function toLocalInput(iso) {
    const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  // keep the screen awake on a wall display
  let wake = null;
  async function keepAwake() { try { wake = await navigator.wakeLock?.request("screen"); } catch {} }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });

  // ── start ─────────────────────────────────────────────────────────────────
  renderSoundBtn();
  renderFeed(false);
  renderStats({ backers: 0, pledged: 0 }, false);
  tickCountdown();
  setInterval(tickCountdown, 1000);
  setInterval(() => renderDays(last && last.state), 60000);
  showMode(DEMO ? "live" : "pre");

  el.gateBtn.onclick = () => {
    el.gate.hidden = true;
    // unlock audio with a silent play inside the click
    el.chime.muted = true;
    el.chime.play().then(() => { el.chime.pause(); el.chime.currentTime = 0; el.chime.muted = false; }).catch(() => { el.chime.muted = false; });
    keepAwake();
    if (DEMO) startDemo();
    else { poll(); setInterval(poll, Math.max(5, cfg.pollSeconds) * 1000); }
  };
})();

"use strict";
/* Copy Trader desk - PAPER only. Vanilla JS, no build step. Data: app-data.json (state + last events) + events-<night>.json (whole night) */
const Q = new URLSearchParams(location.search);
const SOURCES = Q.get("data") ? [Q.get("data").replace(/\/?$/, "/")] : [];
const POLL_MS = 25000, DRIP_S = 12;
const ST = [
  { k: "scout", name: "Scout", role: "scans the coins", c: "var(--blue)", act: "SCANNING", ic: '<circle cx="11" cy="11" r="6"/><path d="M21 21l-5.2-5.2"/>' },
  { k: "filter", name: "Filter", role: "trend, BTC & volume gates", c: "var(--orange)", act: "FILTERING", ic: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>' },
  { k: "risk", name: "Risk", role: "sizing, slots & daily stop", c: "var(--red)", act: "SIZING", ic: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>' },
  { k: "executor", name: "Executor", role: "paper orders", c: "var(--green)", act: "ORDERING", ic: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>' },
  { k: "posmgr", name: "Position manager", role: "exits", c: "var(--yellow)", act: "MANAGING", ic: '<path d="M3 17l5-6 4 3 5-8 4 4"/><path d="M3 21h18"/>' },
];
const SBY = Object.fromEntries(ST.map(s => [s.k, s]));
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const TZ = "America/Toronto";
const fT = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const fD = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const hms = ts => fT.format(new Date(ts * 1000));
const fmtP = x => x == null || isNaN(x) ? "—" : x >= 100 ? x.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(3) : x >= 0.01 ? x.toFixed(4) : x.toPrecision(3);
const sg = (x, d = 2) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(d);
const ago = s => s < 5 ? "now" : s < 90 ? Math.round(s) + "s ago" : s < 5400 ? Math.round(s / 60) + "m ago" : (s / 3600).toFixed(1) + "h ago";
const perf = () => performance.now();

let D = null, CFG = { currency: "CAD", start_capital: 100, risk_pct: 10, max_positions: 2, daily_stop_pct: 5, coins: [] };
let EV = [], cur = 0, S = null, mode = "live", speed = 10, simT = 0, lastTick = perf(), dirty = true, lastFetchOK = 0, offline = false;
const LIVE = {};   // WS prices: coin -> {last, pct}
let wsOK = false;

/* ---------- humanising events ---------- */
const coinOf = e => { const i = e.item || ""; if (i.startsWith("pos-")) return ""; return i.split(":")[0]; };
const posCoin = pair => { const c = CFG.coins.find(c => c.pair === pair); return c ? c.name : (pair || "").replace(/CAD$/, ""); };
const LBL = { trend: "Trend (close > EMA20 > EMA50)", move_band: "24h move outside band", btc_filter: "BTC filter", cooldown: "Cooldown after a loss",
  "signal candle already traded": "Candle already traded", "no_signal: volume below 1.2x": "Volume below 1.2×", "no_signal: candle not green": "Candle not green",
  "daily loss halt": "Daily loss stop", "max open positions reached": "Max positions reached", "ranked below the free slots (weaker 24h move)": "Ranked below free slots",
  "order already pending/open for this pair": "Order already pending", chase: "Chased more than 3%" };
const label = s => LBL[s] || (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, " ");
function describe(e) {
  const v = e.v || {}, c = coinOf(e);
  switch (e.stage + ":" + e.decision) {
    case "scout:btc_pass": return `BTC ${sg(v.btc_pct_vs_ema50 ?? 0, 2)}% vs 1h EMA50 · entries allowed`;
    case "scout:btc_block": return v.error ? "BTC data unavailable · entries blocked" : `BTC ${sg(v.btc_pct_vs_ema50 ?? 0, 2)}% vs 1h EMA50 · entries blocked`;
    case "scout:no_signal": return `${c} no breakout · ${sg(v.move24h_pct ?? 0, 1)}% 24h · vol ${(v.vol_ratio ?? 0).toFixed(1)}×`;
    case "scout:candidate": return `${c} breakout candidate · ${sg(v.move24h_pct ?? 0, 1)}% 24h · vol ${(v.vol_ratio ?? 0).toFixed(1)}×`;
    case "scout:skip": return `${c} already held · skipped`;
    case "scout:error": return `${c || "scan"} data error · will retry`;
    case "filter:pass": return `${c} passed every gate`;
    case "filter:reject": return `${c} rejected · ${e.reason.split(", ").map(label).join(", ")}`;
    case "risk:approve": return `${c} approved · ${(v.size_cad ?? 0).toFixed(2)} ${CFG.currency}${v.slots_left != null ? " · " + v.slots_left + " slot" + (v.slots_left == 1 ? "" : "s") + " left" : ""}`;
    case "risk:reject": return `${c} rejected · ${e.reason.split(", ").map(label).join(", ")}`;
    case "risk:defer": return `${c} deferred · ${e.reason}`;
    case "risk:pause": return "Paused for the night · loss limit hit";
    case "executor:filled": return v.pnl_cad != null ? `Sold ${posCoin(v.pair)} @ ${fmtP(v.price)} · ${sg(v.pnl_cad)} ${CFG.currency} (${(v.exit_reason || "").replace(/_/g, " ")})` : `Bought ${posCoin(v.pair)} @ ${fmtP(v.price)} · ${(v.cost_cad ?? 0).toFixed(2)} ${CFG.currency}`;
    case "executor:dry_run": return e.reason;
    case "executor:reject": return `${c} ${e.reason}`;
    case "executor:error": return `Order error · ${e.reason}`;
    case "posmgr:hold": return `Holding ${posCoin(v.pair)} · bid ${fmtP(v.bid)} · stop ${fmtP(v.stop)} (${v.stop_kind})`;
    case "posmgr:stop_raised": return `${posCoin(v.pair)} stop raised → ${fmtP(v.stop)} (${v.stop_kind})`;
    case "posmgr:exit_signal": return `Exit ${posCoin(v.pair)} · ${e.reason}`;
    case "posmgr:recovered": return "Recovered a stuck closing position";
    case "posmgr:error": return e.reason;
  }
  if (e.item === "sys") return e.reason || e.decision;
  return e.reason || e.decision;
}

/* ---------- reducer: night state at event cursor ---------- */
function newState() {
  return { n: 0, scanned: 0, cands: 0, nosig: 0, passed: 0, approved: 0, buys: 0, wins: 0, losses: 0, pnl: 0, btcPass: 0, btcBlock: 0, rej: { filter: {}, risk: {} },
    at: {}, last: {}, lastEv: null, pos: {}, closed: [], coin: {}, log: [], btc: null, paused: false, halted: false, errors: 0 };
}
function apply(s, e, fx) {
  const v = e.v || {}; s.n++;
  if (fx) s.at[e.stage] = perf();
  if (e.item !== "sys" || !s.last[e.stage]) s.last[e.stage] = e; else if (e.decision === "stop") s.last[e.stage] = e;
  s.lastEv = e;
  const k = e.stage + ":" + e.decision;
  if (k === "scout:btc_pass" || k === "scout:btc_block") { s.btc = { ok: k === "scout:btc_pass", pct: v.btc_pct_vs_ema50, ts: e.ts }; s[k === "scout:btc_pass" ? "btcPass" : "btcBlock"]++; }
  else if (k === "scout:no_signal" || k === "scout:candidate") {
    s.scanned++; if (k === "scout:candidate") s.cands++; else s.nosig++;
    s.coin[v.coin] = { move: v.move24h_pct, vol: v.vol_ratio, cand: k === "scout:candidate", ts: e.ts };
  } else if (k === "scout:skip") { s.scanned++; const c = s.coin[e.item] = s.coin[e.item] || {}; c.held = true; }
  else if (k === "scout:error" || k === "executor:error" || k === "posmgr:error") s.errors++;
  else if (k === "filter:pass") s.passed++;
  else if (e.stage === "filter" && e.decision === "reject") for (const r of e.reason.split(", ")) s.rej.filter[r] = (s.rej.filter[r] || 0) + 1;
  else if (k === "risk:approve") s.approved++;
  else if (e.stage === "risk" && e.decision === "reject") { for (const r of e.reason.split(", ")) s.rej.risk[r] = (s.rej.risk[r] || 0) + 1; if (e.reason === "daily loss halt") s.halted = true; }
  else if (k === "risk:pause") s.paused = true;
  else if (k === "executor:filled") {
    if (v.pnl_cad == null) {
      s.buys++; s.pos[v.pos_id] = { id: v.pos_id, pair: v.pair, coin: posCoin(v.pair), entry: v.price, vol: v.volume, cost: v.cost_cad, stop: v.stop, kind: "initial", peak: v.price, bid: v.price, ts: e.ts };
      (s.coin[posCoin(v.pair)] = s.coin[posCoin(v.pair)] || {}).held = true;
    } else {
      const p = s.pos[v.pos_id] || { id: v.pos_id, pair: v.pair, coin: posCoin(v.pair), entry: null, cost: null, ts: null };
      delete s.pos[v.pos_id]; if (s.coin[p.coin]) s.coin[p.coin].held = false;
      s.pnl += v.pnl_cad; v.pnl_cad >= 0 ? s.wins++ : s.losses++;
      s.closed.unshift({ ...p, exit: v.price, pnl: v.pnl_cad, pct: v.pnl_pct, why: v.exit_reason, tc: e.ts });
    }
  } else if (e.stage === "posmgr" && (e.decision === "hold" || e.decision === "stop_raised")) {
    const id = +String(e.item).replace("pos-", ""), p = s.pos[id];
    if (p) { if (v.bid != null) p.bid = v.bid; if (v.stop != null) p.stop = v.stop; if (v.stop_kind) p.kind = v.stop_kind; if (v.peak != null) p.peak = v.peak; }
  }
  if (e.stage !== "server" && e.stage !== "queue") {
    s.log.push(e); if (s.log.length > 60) s.log.shift();
  }
}

/* ---------- engine: live drip / replay / pause ---------- */
function seek(n, fx) {
  n = Math.max(0, Math.min(EV.length, n));
  if (n < cur || !S) { S = newState(); cur = 0; }
  while (cur < n) apply(S, EV[cur], fx && n - cur <= 40), cur++;
  if (cur) simT = EV[cur - 1].ts;
  dirty = true;
}
function tick() {
  const now = perf(), dt = (now - lastTick) / 1000; lastTick = now;
  if (mode !== "pause" && cur < EV.length) {
    let rate = 1;
    if (mode === "replay") rate = speed;
    else { const back = EV[EV.length - 1].ts - simT; rate = Math.max(1, back / DRIP_S); }
    if (!simT && cur) simT = EV[cur - 1].ts;
    simT += dt * rate; let moved = false;
    while (cur < EV.length && EV[cur].ts <= simT) { apply(S, EV[cur++], true); moved = true; }
    if (moved) dirty = true;
    if (cur >= EV.length && mode === "replay") { mode = "live"; dirty = true; }
  }
  if (dirty) { render(); dirty = false; }
  else if ((now | 0) % 1000 < 120) renderLight();
}
setInterval(tick, 100);

/* ---------- data ----------
   Sources (the page itself lives on github.io, and raw.githubusercontent.com can answer 404 / be cached ~5 min there, so there are three):
   1. raw `data` branch   - refreshed every minute by the publisher, CDN-cached up to 5 min
   2. GitHub API contents - always fresh (60 s cache) but unauthenticated limit is 60 req/h, so used only when 1+3 are stale, max 1 per 90 s, only 00:00-08:45 ET
   3. ./data/ on Pages    - published every 10 min, always reachable
   The freshest copy (generated_at) wins. ?data=<dir/> overrides everything (demo / local preview). */
const REPO = "RedDot-3ND7355/copytrader-desk";
const RAWB = `https://raw.githubusercontent.com/${REPO}/data/`, APIB = `https://api.github.com/repos/${REPO}/contents/`, PAGES = "./data/";
let apiOKAt = 0, lastEvFetch = Date.now();
async function tryOne(url, headers) {
  try {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 12000);
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Math.floor(Date.now() / 20000), { cache: "no-store", signal: ac.signal, headers });
    clearTimeout(tm);
    if (r.ok) return await r.json();
    if (r.status === 403 || r.status === 429) apiOKAt = Math.max(apiOKAt, Date.now() + 15 * 60000);
  } catch (e) {}
  return null;
}
const etHour = () => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()); return +p[0].value + +p[2].value / 60; };
async function getJSON(name) {          // static-ish file (events): first source that answers
  if (Q.get("data")) return tryOne(SOURCES[0] + name);
  return (await tryOne(RAWB + name)) || (await tryOne(PAGES + name)) || (await tryOne(APIB + name + "?ref=data", { Accept: "application/vnd.github.raw" }));
}
async function getState() {
  if (Q.get("data")) return tryOne(SOURCES[0] + "app-data.json");
  const got = (await Promise.all([tryOne(RAWB + "app-data.json"), tryOne(PAGES + "app-data.json")])).filter(Boolean).sort((x, y) => y.generated_at - x.generated_at);
  let best = got[0] || null;
  const age = best ? Date.now() / 1000 - best.generated_at : 1e9;
  if (age > 150 && Date.now() > apiOKAt && etHour() < 8.75) {
    apiOKAt = Date.now() + 90000;
    const c = await tryOne(APIB + "app-data.json?ref=data", { Accept: "application/vnd.github.raw" });
    if (c && (!best || c.generated_at > best.generated_at)) best = c;
  }
  return best;
}
const norm = r => ({ seq: r[0], ts: r[1], stage: r[2], item: r[3], decision: r[4], reason: r[5], v: r[6] || {} });
async function loadEvents(d) {
  const f = await getJSON(d.events_file);
  return f ? f.rows.map(norm).filter(e => e.stage !== "server" && e.stage !== "queue") : [];
}
async function poll(first) {
  const d = await getState();
  if (!d) { offline = true; dirty = true; return; }
  offline = false; lastFetchOK = Date.now();
  const newNight = D && D.night !== d.night;
  D = d; CFG = d.cfg || CFG;
  if (first || newNight) {
    EV = await loadEvents(d); mergeTail(d.tail);
    S = null; cur = 0; buildCoinChips(); seek(EV.length, false);
    const sk = parseFloat(Q.get("seek")); if (!isNaN(sk)) { mode = "pause"; seek(Math.round(EV.length * sk), false); }
    if (Q.get("replay")) { speed = +Q.get("speed") || 60; seek(0, false); mode = "replay"; simT = EV.length ? EV[0].ts - 1 : 0; }
  } else {
    const had = EV.length; const last = had ? EV[had - 1].seq : 0;
    if (d.tail.length && d.tail[0][0] > last + 1 && had && Date.now() - lastEvFetch > 300000) { lastEvFetch = Date.now(); EV = await loadEvents(d); mergeTail(d.tail); if (cur > EV.length) cur = EV.length; }
    else mergeTail(d.tail);
  }
  dirty = true;
}
function mergeTail(tail) {
  let last = EV.length ? EV[EV.length - 1].seq : 0;
  for (const r of tail || []) if (r[0] > last && r[2] !== "server" && r[2] !== "queue") { EV.push(norm(r)); last = r[0]; }
}

/* ---------- Kraken WS (public prices) ---------- */
let ws, wsTry = 0;
function connectWS() {
  if (!CFG.coins.length) return;
  try { ws = new WebSocket("wss://ws.kraken.com/v2"); } catch (e) { return; }
  ws.onopen = () => { wsOK = true; wsTry = 0; ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: CFG.coins.map(c => c.ws) } })); };
  ws.onmessage = m => {
    let j; try { j = JSON.parse(m.data); } catch (e) { return; }
    if (j.channel !== "ticker" || !j.data) return;
    for (const d of j.data) {
      const c = CFG.coins.find(c => c.ws === d.symbol); if (!c) continue;
      const prev = LIVE[c.name] && LIVE[c.name].last; LIVE[c.name] = { last: d.last, bid: d.bid, pct: d.change_pct };
      priceTick(c.name, prev);
    }
  };
  ws.onclose = ws.onerror = () => { wsOK = false; ws = null; setTimeout(connectWS, Math.min(30000, 2000 * ++wsTry)); };
}

/* ---------- UI ---------- */
const V = {};   // cached element refs
function mk(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function build() {
  $("#v-overview").innerHTML = `
  <div class="banner" id="banner"><i class="dot"></i><div class="t">Loading…</div><div class="ago"></div></div>
  <div class="card bal">
    <div class="meta"><div>Start<b id="m-start">—</b></div><div>Risk<b id="m-risk">—</b></div><div>Max pos<b id="m-max">—</b></div><div>Daily stop<b id="m-stop">—</b></div></div>
    <div class="big"><span class="n" id="bal-n">0.00</span><span class="cur" id="bal-c">CAD</span></div>
    <div class="pl"><span id="pl-v">+0.00</span><span class="badge" id="pl-b">1.00×</span></div>
    <div class="state" id="bal-state"></div>
  </div>
  <div class="stats">
    <div><div class="v" id="s-scan">0</div><div class="l">SCANNED</div></div><div><div class="v" id="s-pass">0</div><div class="l">PASSED</div></div>
    <div><div class="v" id="s-trades">0</div><div class="l">TRADES</div></div><div><div class="v" id="s-wl">0-0</div><div class="l">W-L</div></div>
  </div>
  <div class="h"><span>Coins</span><span class="mono" id="wsstat" style="letter-spacing:0;text-transform:none"></span></div>
  <div class="chips" id="chips"></div>
  <div class="foot" id="foot"></div>`;
  $("#v-agents").innerHTML = `
  <div class="ctl">
    <div class="seg"><button data-m="pause"><svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>Pause</button><button data-m="live"><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4"/></svg>Live</button><button data-m="replay"><svg viewBox="0 0 12 12"><path d="M3 1l8 5-8 5z"/></svg>Replay</button></div>
    <div class="spd" id="spd">${[1, 10, 60, 300].map(x => `<button data-s="${x}">${x}x</button>`).join("")}</div>
    <div class="scrub"><input type="range" id="scrub" min="0" max="0" value="0"><span id="evc">event 0 / 0</span></div>
  </div>
  <div id="agents">${ST.map(s => `<div class="agent idle" id="ag-${s.k}" style="--ac:${s.c}"><div class="ic"><svg viewBox="0 0 24 24">${s.ic}</svg></div><div class="bd"><div class="nm">${s.name}<small>${s.role}</small></div><div class="doing">Waiting…</div></div><div class="pillo">IDLE</div></div>`).join("")}</div>`;
  $("#v-activity").innerHTML = `
  <div class="h"><span>Funnel</span><span class="mono" id="fun-n" style="letter-spacing:0;text-transform:none"></span></div>
  <div class="card fun" id="fun"></div>
  <div class="h"><span>Log</span></div>
  <div class="logbox"><div class="lh"><span>logger.tail</span><span id="log-st">● live</span></div><div class="log" id="log"></div></div>`;
  $("#v-trades").innerHTML = `<div id="tr-sum" class="h"></div><div id="tr-open"></div><div class="h" id="tr-ch"><span>Closed</span></div><div id="tr-closed"></div>`;
  for (const b of document.querySelectorAll(".seg button")) b.onclick = () => setMode(b.dataset.m);
  for (const b of document.querySelectorAll("#spd button")) b.onclick = () => { speed = +b.dataset.s; dirty = true; };
  $("#scrub").oninput = e => { if (mode === "live" || mode === "replay") mode = "pause"; seek(+e.target.value, true); };
  for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => tab(b.dataset.tab);
}
function setMode(m) {
  if (m === "replay") { if (mode !== "pause" || cur >= EV.length) { seek(0, false); simT = EV.length ? EV[0].ts - 1 : 0; } mode = "replay"; }
  else if (m === "live") { mode = "live"; if (EV.length - cur > 400) seek(EV.length, true); }
  else mode = "pause";
  dirty = true;
}
function tab(t) {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === t);
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "v-" + t;
  if (location.hash !== "#" + t) history.replaceState(null, "", "#" + t);
  window.scrollTo(0, 0); dirty = true;
}
function buildCoinChips() {
  $("#chips").innerHTML = CFG.coins.map(c => `<div class="chip" id="ch-${c.name}"><div class="s">${c.name}<em></em></div><div class="p">—</div><div class="c dim">—</div></div>`).join("");
}
/* count-up numbers */
function countTo(el, n, dec = 0, fmt) {
  if (!el) return; const f = fmt || (x => x.toFixed(dec));
  if (el._t === n) return; const from = el._v == null ? n : el._v; el._t = n; const t0 = perf();
  cancelAnimationFrame(el._r);
  const st = () => { const k = Math.min(1, (perf() - t0) / 450), x = from + (n - from) * (1 - Math.pow(1 - k, 3)); el._v = x; el.textContent = f(x); if (k < 1) el._r = requestAnimationFrame(st); else el._v = n; };
  if (el._v == null) { el._v = n; el.textContent = f(n); } else st();
}
const setT = (el, t) => { if (el && el._x !== t) { el._x = t; el.textContent = t; return true; } return false; };
const setH = (el, h) => { if (el && el._x !== h) { el._x = h; el.innerHTML = h; return true; } return false; };
const flash = el => { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); };
const isOpenView = t => !$("#v-" + t).hidden;

function equity() {
  const start = CFG.start_capital;
  const atEnd = cur >= EV.length && mode === "live" && D && D.state && D.state.balance && D.state.balance.equity != null;
  if (atEnd) return D.state.balance.equity;
  let un = 0; for (const p of Object.values(S.pos)) un += (p.bid - p.entry) * p.vol;
  return start + S.pnl + un;
}
function stateText() {
  const n = Object.keys(S.pos).length;
  let t, col = "var(--tx2)";
  if (S.halted) { t = `Daily loss stop (${CFG.daily_stop_pct}%) hit — no new entries tonight.`; col = "var(--red)"; }
  else if (S.paused) { t = "Paused after consecutive losses — managing exits only."; col = "var(--orange)"; }
  else if (n) { t = `Holding ${n} position${n > 1 ? "s" : ""} — trailing stops active, flat at ${String(CFG.close_hour || 8).padStart(2, "0")}:00 ET.`; col = "var(--green)"; }
  else if (S.btc && !S.btc.ok) { t = `Strict BTC filter is blocking entries — BTC is ${sg(S.btc.pct ?? 0, 2)}% vs its 1h EMA50. Scanning continues, no orders.`; col = "var(--red)"; }
  else if (S.btc) { t = `BTC filter open — scanning ${CFG.coins.length} coins for breakouts, waiting for a signal that passes every gate.`; col = "var(--green)"; }
  else { t = "Waiting for the first scan…"; }
  return [t, col];
}
function render() {
  if (!S) return;
  const live = mode === "live" && cur >= EV.length;
  // pill
  const lp = $("#livepill"), lastTs = EV.length ? EV[EV.length - 1].ts : 0, age = Date.now() / 1000 - lastTs;
  let cls = "livepill", txt;
  if (offline && !D) { cls += " off"; txt = "OFFLINE"; }
  else if (mode === "replay") { cls += " replay"; txt = `REPLAY ${speed}x`; }
  else if (mode === "pause") { cls += " pause"; txt = "PAUSED"; }
  else if (!lastTs) { cls += " off"; txt = "NO DATA"; }
  else if (age > 240) { cls += " warn"; txt = "IDLE " + ago(age).replace(" ago", ""); }
  else { txt = "LIVE"; }
  if (lp.className !== cls) lp.className = cls; setT(lp.lastElementChild, txt);
  // overview
  const start = CFG.start_capital, eq = equity(), pl = eq - start;
  setT($("#m-start"), start.toFixed(0)); setT($("#m-risk"), CFG.risk_pct + "%"); setT($("#m-max"), CFG.max_positions); setT($("#m-stop"), CFG.daily_stop_pct + "%");
  countTo($("#bal-n"), eq, 2, x => x.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })); setT($("#bal-c"), CFG.currency);
  const plv = $("#pl-v"); setT(plv, `${sg(pl)} ${CFG.currency} (${sg(pl / start * 100)}%)`); plv.className = pl > 0.0005 ? "g" : pl < -0.0005 ? "r" : "dim";
  const pb = $("#pl-b"); setT(pb, (eq / start).toFixed(2) + "×"); pb.style.color = pl > 0.0005 ? "var(--green)" : pl < -0.0005 ? "var(--red)" : "var(--tx2)";
  const [stx, stc] = stateText(); setH($("#bal-state"), `<i style="background:${stc}"></i>${esc(stx)}`);
  countTo($("#s-scan"), S.scanned); countTo($("#s-pass"), S.passed); countTo($("#s-trades"), S.buys); setT($("#s-wl"), `${S.wins}-${S.losses}`);
  const e = S.lastEv, ban = $("#banner");
  if (e) {
    const st = SBY[e.stage], when = live ? ago(Date.now() / 1000 - e.ts) : hms(e.ts);
    const h = `<i class="dot" style="background:${st ? st.c : "#888"}"></i><div class="t"><b>${st ? st.name : e.stage}</b> · ${esc(describe(e))}</div><div class="ago">${when}</div>`;
    if (setH(ban, h)) flash(ban), ban.style.setProperty("--ac", st ? st.c : "#fff");
  } else setH(ban, `<i class="dot" style="background:#555"></i><div class="t dim">No events yet tonight — the bot starts scanning at 00:00 ET.</div><div class="ago"></div>`);
  for (const c of CFG.coins) {
    const el = $("#ch-" + c.name); if (!el) continue; const ci = S.coin[c.name] || {}, lv = LIVE[c.name];
    const held = Object.values(S.pos).some(p => p.coin === c.name);
    el.classList.toggle("held", held); el.classList.toggle("cand", !held && !!ci.cand && S.lastEv && S.lastEv.ts - ci.ts < 120);
    const tag = held ? "HELD" : (ci.cand && S.lastEv && S.lastEv.ts - ci.ts < 120) ? "SIGNAL" : c.name === "BTC" && S.btc ? (S.btc.ok ? "ABOVE EMA" : "BELOW EMA") : "";
    const em = el.querySelector("em"); setT(em, tag); em.style.color = held ? "var(--green)" : tag === "SIGNAL" ? "var(--orange)" : tag === "BELOW EMA" ? "var(--red)" : tag ? "var(--green)" : "";
    if (lv) setT(el.querySelector(".p"), fmtP(lv.last));
    const mv = ci.move != null ? ci.move : lv ? lv.pct : null;
    const cc = el.querySelector(".c"); setT(cc, mv == null ? "—" : `${sg(mv, 1)}% 24h${ci.vol != null ? " · vol " + ci.vol.toFixed(1) + "×" : ""}`); cc.style.color = mv == null ? "" : mv >= 0 ? "var(--green)" : "var(--red)";
  }
  setT($("#wsstat"), wsOK ? "● Kraken live" : "○ prices offline");
  $("#wsstat").style.color = wsOK ? "var(--green)" : "var(--tx2)";
  setT($("#foot"), `${Q.get("data") ? "DEMO DATA (synthetic, not a real night) · " : ""}Night ${D ? D.night : "—"} · PAPER money only, no real orders · ${D ? "updated " + fD.format(new Date(D.generated_at * 1000)) + " ET" : ""}`);
  // agents
  const sc = $("#scrub"); if (+sc.max !== EV.length) sc.max = EV.length; if (document.activeElement !== sc || mode === "replay") sc.value = cur;
  setT($("#evc"), `event ${cur} / ${EV.length}`);
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.m === mode);
  for (const b of document.querySelectorAll("#spd button")) b.classList.toggle("on", +b.dataset.s === speed);
  $("#spd").classList.toggle("off", mode !== "replay");
  const nopen = Object.keys(S.pos).length, now = perf();
  for (const s of ST) {
    const el = $("#ag-" + s.k), ev = S.last[s.k], act = S.at[s.k] && now - S.at[s.k] < 1800;
    const doing = ev ? describe(ev) : "Waiting for the first event…";
    if (setT(el.querySelector(".doing"), doing) && S.at[s.k] && now - S.at[s.k] < 600) flash(el);
    el.classList.toggle("active", !!act); el.classList.toggle("idle", !act);
    const stopped = ev && ev.item === "sys" && ev.decision === "stop";
    setT(el.querySelector(".pillo"), stopped ? "STOPPED" : act ? s.act : !ev ? "WAITING" : s.k === "posmgr" ? (nopen ? "WATCHING " + nopen : "FLAT") : "IDLE");
  }
  renderFunnel(); renderLog(); renderTrades();
}
function renderLight() { if (!S) return; const e = S.lastEv; if (e && mode === "live") { const a = $("#banner .ago"); if (a) a.textContent = ago(Date.now() / 1000 - e.ts); } }
function priceTick(name, prev) {
  const el = $("#ch-" + name); if (!el) return; const p = el.querySelector(".p"), lv = LIVE[name];
  setT(p, fmtP(lv.last));
  if (prev != null && prev !== lv.last) { el.classList.remove("up", "dn"); void el.offsetWidth; el.classList.add(lv.last > prev ? "up" : "dn"); }
  if (S && isOpenView("trades")) dirty = true;
}
function renderFunnel() {
  if (!isOpenView("activity")) return;
  const tot = Math.max(1, S.scanned), row = (k, n, c, cls = "") => `<div class="r1 ${cls}" style="--ac:${c}"><span class="k">${cls === "sub" ? "" : '<i></i>'}${esc(k)}</span><span class="n">${n}</span>${cls === "sub" ? "" : `<span class="bar" style="width:${Math.min(100, n / tot * 100)}%"></span>`}</div>`;
  let h = row("Coins scanned", S.scanned, "var(--blue)", "tot");
  h += row("no breakout", S.nosig, "", "sub") + row(`BTC filter: ${S.btcBlock} blocked / ${S.btcPass} open (scans)`, "", "", "sub");
  h += row("Breakout candidates", S.cands, "var(--blue)", "tot");
  const rf = Object.entries(S.rej.filter).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of rf) h += row("✕ " + label(k), n, "", "sub");
  h += row("Passed the filter", S.passed, "var(--orange)", "tot");
  for (const [k, n] of Object.entries(S.rej.risk).sort((a, b) => b[1] - a[1])) h += row("✕ " + label(k), n, "", "sub");
  h += row("Approved by risk", S.approved, "var(--red)", "tot");
  h += row("Trades opened", S.buys, "var(--green)", "tot");
  setH($("#fun"), h); setT($("#fun-n"), `${S.scanned} scans → ${S.buys} trade${S.buys == 1 ? "" : "s"}`);
}
function renderLog() {
  if (!isOpenView("activity")) return;
  const box = $("#log"), tail = S.log.slice(-40); const key = tail.length ? tail[tail.length - 1].seq + ":" + tail.length : "";
  if (box._k === key) return; const prev = box._k; box._k = key;
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = tail.map(e => { const st = SBY[e.stage]; return `<div${e.seq > (box._seq || 1e12) ? ' class="new"' : ""}><span class="t">${hms(e.ts)}</span> <span class="s" style="color:${st ? st.c : "#888"}">${esc(e.stage)}</span>${esc(describe(e))}</div>`; }).join("") || '<div class="dim">no events yet</div>';
  box._seq = tail.length ? tail[tail.length - 1].seq : 0;
  if (nearEnd || !prev) box.scrollTop = box.scrollHeight;
  setT($("#log-st"), mode === "replay" ? "● replay " + speed + "x" : mode === "pause" ? "❚❚ paused" : "● live");
}
function renderTrades() {
  if (!isOpenView("trades")) return;
  const open = Object.values(S.pos), cl = S.closed, C = CFG.currency;
  setH($("#tr-sum"), `<span>Open ${open.length} · Closed ${cl.length}</span><span class="mono" style="letter-spacing:0;text-transform:none">W-L ${S.wins}-${S.losses}</span>`);
  const live = mode === "live" && cur >= EV.length;
  const oh = open.map(p => {
    const px = live && LIVE[p.coin] ? LIVE[p.coin].bid || LIVE[p.coin].last : p.bid, pl = (px - p.entry) * p.vol, pc = (px / p.entry - 1) * 100;
    return `<div class="tr open"><div class="a"><b>${p.coin} <span class="dim" style="font-weight:500;font-size:12px">${p.pair}</span></b><span class="pl ${pl >= 0 ? "g" : "r"}">${sg(pl, 3)} ${C} · ${sg(pc)}%</span></div>
    <div class="grid"><div>Entry<b>${fmtP(p.entry)}</b></div><div>Now<b>${fmtP(px)}</b></div><div>Stop (${esc(p.kind)})<b>${fmtP(p.stop)}</b></div><div>Size<b>${p.cost.toFixed(2)} ${C}</b></div><div>Peak<b>${fmtP(p.peak)}</b></div><div>Opened<b>${hms(p.ts)}</b></div></div></div>`;
  }).join("");
  const ch = cl.map(p => `<div class="tr"><div class="a"><b>${p.coin} <span class="dim" style="font-weight:500;font-size:12px">${p.pair}</span></b><span class="pl ${p.pnl >= 0 ? "g" : "r"}">${sg(p.pnl, 3)} ${C} · ${sg(p.pct ?? 0)}%</span></div>
    <div class="grid"><div>Entry<b>${fmtP(p.entry)}</b></div><div>Exit<b>${fmtP(p.exit)}</b></div><div>Size<b>${p.cost != null ? p.cost.toFixed(2) + " " + C : "—"}</b></div></div>
    <div class="why">${esc((p.why || "").replace(/_/g, " "))} · ${hms(p.tc)} ET</div></div>`).join("");
  const empty = `<div class="empty"><svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 5-8 4 4M3 21h18"/></svg><b>No trades yet</b>${esc(stateText()[0])}</div>`;
  setH($("#tr-open"), oh || (cl.length ? '<div class="dim" style="padding:2px 4px 8px">No open positions.</div>' : empty));
  $("#tr-ch").style.display = cl.length ? "" : "none"; setH($("#tr-closed"), ch);
}

/* ---------- boot ---------- */
build();
tab((location.hash || "#overview").slice(1).replace(/[^a-z]/g, "") && $("#v-" + location.hash.slice(1)) ? location.hash.slice(1) : "overview");
poll(true).then(() => { if (D) connectWS(); else setTimeout(() => poll(true).then(() => D && connectWS()), 8000); });
setInterval(() => poll(false), POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(false); });
if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !Q.get("nosw")) navigator.serviceWorker.register("sw.js").catch(() => {});

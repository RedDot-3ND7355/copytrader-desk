"use strict";
/* Copy Trader desk - PAPER only. Vanilla JS, no build step. Data: app-data.json (state + last events) + events-<night>.json (whole night) */
const Q = new URLSearchParams(location.search);
const SOURCES = Q.get("data") ? [Q.get("data").replace(/\/?$/, "/")] : [];
const POLL_MS = 10000;
const ST = [
  { k: "scout", name: "Scout", role: "scans the coins", c: "var(--blue)", act: "SCANNING", ic: '<circle cx="11" cy="11" r="6"/><path d="M21 21l-5.2-5.2"/>' },
  { k: "filter", name: "Filter", role: "trend, BTC & volume gates", c: "var(--orange)", act: "FILTERING", ic: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>' },
  { k: "risk", name: "Risk", role: "sizing, slots & daily stop", c: "var(--red)", act: "SIZING", ic: '<path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"/>' },
  { k: "executor", name: "Executor", role: "paper orders", c: "var(--green)", act: "ORDERING", ic: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>' },
  { k: "posmgr", name: "Position manager", role: "exits", c: "var(--yellow)", act: "MANAGING", ic: '<path d="M3 17l5-6 4 3 5-8 4 4"/><path d="M3 21h18"/>' },
];
const SBY = Object.fromEntries(ST.map(s => [s.k, s]));
const LOGS = { scout: ["scout", "var(--blue)"], filter: ["filter", "var(--orange)"], risk: ["risk", "var(--red)"], executor: ["executor", "var(--green)"], posmgr: ["posmgr", "var(--yellow)"], supervisor: ["super", "var(--indigo)"], queue: ["queue", "#888"] };
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
let EV = [], cur = 0, S = null, mode = "live", speed = 10, lastTick = perf(), dirty = true, lastFetchOK = 0, offline = false;
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
    at: {}, last: {}, lastEv: null, pos: {}, closed: [], coin: {}, log: [], btc: null, paused: false, halted: false, errors: 0,
    chk: 0, held: 0, ns: { trend: 0, vol: 0, red: 0 }, nsF: 0, scanTs: [], lastCoin: null, fRej: 0, rin: 0, rRej: 0, rDef: 0, sent: 0, sentSell: 0, failed: 0, holds: 0, stops: 0, be: 0, trail: 0,
    exitWhy: {}, streak: 0, lastSize: null, err: {}, starts: {}, spark: {}, lastFill: null };
}
function apply(s, e, fx) {
  const v = e.v || {}; s.n++;
  if (fx) s.at[e.stage] = perf();
  if (e.item !== "sys" || !s.last[e.stage]) s.last[e.stage] = e; else if (e.decision === "stop") s.last[e.stage] = e;
  s.lastEv = e;
  const k = e.stage + ":" + e.decision;
  if (e.item === "sys") { if (e.decision === "start") s.starts[e.stage] = (s.starts[e.stage] || 0) + 1; }
  else { const sp = s.spark[e.stage] || (s.spark[e.stage] = {}), b = Math.floor(e.ts / 600); sp[b] = (sp[b] || 0) + 1; }
  if (e.decision === "error") s.err[e.stage] = (s.err[e.stage] || 0) + 1;
  if (k === "scout:btc_pass" || k === "scout:btc_block") { s.btc = { ok: k === "scout:btc_pass", pct: v.btc_pct_vs_ema50, ts: e.ts }; s[k === "scout:btc_pass" ? "btcPass" : "btcBlock"]++; s.scanTs.push(e.ts); if (s.scanTs.length > 24) s.scanTs.shift(); }
  else if (k === "scout:no_signal" || k === "scout:candidate") {
    s.scanned++; if (k === "scout:candidate") s.cands++; else s.nosig++;
    s.coin[v.coin] = { move: v.move24h_pct, vol: v.vol_ratio, cand: k === "scout:candidate", ts: e.ts, gap: k === "scout:candidate" ? 0 : v.gap_pct };
    s.chk++; s.lastCoin = { coin: v.coin, move: v.move24h_pct, vol: v.vol_ratio, gap: k === "scout:candidate" ? 0 : v.gap_pct, cand: k === "scout:candidate", ts: e.ts };
    if (k === "scout:no_signal" && v.trend_ok != null) { s.nsF++; if (!v.trend_ok) s.ns.trend++; if (!v.volume_ok) s.ns.vol++; if (!v.green) s.ns.red++; }
  } else if (k === "scout:skip") { s.scanned++; s.held++; const c = s.coin[e.item] = s.coin[e.item] || {}; c.held = true; }
  else if (k === "scout:error" || k === "executor:error" || k === "posmgr:error") { s.errors++; if (k === "executor:error") s.failed++; }
  else if (k === "filter:pass") s.passed++;
  else if (e.stage === "filter" && e.decision === "reject") { s.fRej++; for (const r of e.reason.split(", ")) s.rej.filter[r] = (s.rej.filter[r] || 0) + 1; }
  else if (k === "risk:approve") { s.approved++; s.rin++; s.sent++; s.lastSize = v.size_cad; }
  else if (k === "risk:defer") { s.rin++; s.rDef++; }
  else if (e.stage === "risk" && e.decision === "reject") { s.rin++; s.rRej++; for (const r of e.reason.split(", ")) s.rej.risk[r] = (s.rej.risk[r] || 0) + 1; if (e.reason === "daily loss halt") s.halted = true; }
  else if (k === "risk:pause") s.paused = true;
  else if (k === "executor:filled") {
    if (v.pnl_cad == null) {
      s.buys++; s.pos[v.pos_id] = { id: v.pos_id, pair: v.pair, coin: posCoin(v.pair), entry: v.price, vol: v.volume, cost: v.cost_cad, stop: v.stop, kind: "initial", peak: v.price, bid: v.price, ts: e.ts };
      (s.coin[posCoin(v.pair)] = s.coin[posCoin(v.pair)] || {}).held = true;
    } else {
      const p = s.pos[v.pos_id] || { id: v.pos_id, pair: v.pair, coin: posCoin(v.pair), entry: null, cost: null, ts: null };
      delete s.pos[v.pos_id]; if (s.coin[p.coin]) s.coin[p.coin].held = false;
      s.pnl += v.pnl_cad; v.pnl_cad >= 0 ? s.wins++ : s.losses++; s.streak = v.pnl_cad >= 0 ? 0 : s.streak + 1;
      const xr = (v.exit_reason || "exit"); s.exitWhy[xr] = (s.exitWhy[xr] || 0) + 1;
      s.closed.unshift({ ...p, exit: v.price, pnl: v.pnl_cad, pct: v.pnl_pct, why: v.exit_reason, tc: e.ts });
    }
    s.lastFill = e;
  } else if (k === "executor:reject") s.failed++;
  else if (k === "posmgr:exit_signal") s.sent++, s.sentSell++;
  else if (e.stage === "posmgr" && (e.decision === "hold" || e.decision === "stop_raised")) {
    if (e.decision === "hold") s.holds++; else { s.stops++; v.stop_kind === "breakeven" ? s.be++ : s.trail++; }
    const id = +String(e.item).replace("pos-", ""), p = s.pos[id];
    if (p) { if (v.bid != null) p.bid = v.bid; if (v.stop != null) p.stop = v.stop; if (v.stop_kind) p.kind = v.stop_kind; if (v.peak != null) p.peak = v.peak; }
  }
  if (e.stage !== "server") {
    s.log.push(e); if (s.log.length > 2500) s.log.shift();
  }
}

/* ---------- engine: live drip / replay / pause ---------- */
function seek(n, fx) {
  n = Math.max(0, Math.min(EV.length, n));
  if (n < cur || !S) { S = newState(); cur = 0; }
  while (cur < n) apply(S, EV[cur], fx && n - cur <= 40), cur++;
  nextAt = 0; dirty = true;
}
/* Replay & live drip are EVENT-STEPPED: one event is applied at a time (glow, counter tick, log line), and the speed button sets the delay between events.
   Idle gaps are compressed: the delay grows with the real gap but is capped at the max below, so a quiet hour never freezes the replay. */
const GAPS = { 1: [700, 1500], 10: [260, 700], 60: [90, 260], 300: [28, 90] };   // speed -> [min, max] ms between events
const stepMs = () => GAPS[speed] || GAPS[60];
function delayFor(i) {            // ms to wait before showing EV[i]
  const [lo, hi] = stepMs(), gap = i > 0 ? EV[i].ts - EV[i - 1].ts : 30;
  return lo + (hi - lo) * Math.min(1, Math.max(0, gap) / 90);
}
function tick() {
  const now = perf(); lastTick = now;
  if (mode !== "pause" && cur < EV.length) {
    const back = EV.length - cur;
    const dl = i => mode === "replay" ? delayFor(i) : Math.min(1200, Math.max(100, 12000 / back));   // live: drip a backlog out over ~12 s
    if (!nextAt) nextAt = now + (mode === "replay" ? dl(cur) : 0);
    let n = 0;
    while (cur < EV.length && now >= nextAt && n < 4) { apply(S, EV[cur++], true); n++; nextAt = cur < EV.length ? Math.max(nextAt + dl(cur), now - 200 + 10) : 0; }
    if (n) dirty = true;
    if (cur >= EV.length && mode === "replay") { mode = "live"; nextAt = 0; dirty = true; }
  }
  if (dirty) { render(); dirty = false; }
  else if ((now | 0) % 1000 < 120) renderLight();
}
let nextAt = 0;
function step(d) { if (mode !== "pause") mode = "pause"; seek(cur + d, d > 0); }
setInterval(tick, 25);

/* ---------- data ----------
   Sources (the page itself lives on github.io, and raw.githubusercontent.com can answer 404 / be cached ~5 min there, so there are three):
   1. GitHub API contents of the `data` branch (ETag-revalidated, ~1 s behind the publisher) - the live path, only 23:54-08:45 ET
   2. raw `data` branch   - same files but the CDN keeps them 5 min (query strings are ignored), so fallback only
   3. ./data/ on Pages    - published every 10 min, always reachable
   The freshest copy (generated_at) wins. ?data=<dir/> overrides everything (demo / local preview). */
const REPO = "RedDot-3ND7355/copytrader-desk";
const RAWB = `https://raw.githubusercontent.com/${REPO}/data/`, APIB = `https://api.github.com/repos/${REPO}/contents/`, PAGES = "./data/";
let apiOKAt = 0, lastEvFetch = Date.now();
async function tryOne(url, headers) {
  try {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 12000);
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store", signal: ac.signal, headers });
    clearTimeout(tm);
    if (r.ok) return await r.json();
  } catch (e) {}
  return null;
}
const etHour = () => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()); return +p[0].value + +p[2].value / 60; };
async function getJSON(name) {          // static-ish file (events): first source that answers
  if (Q.get("data")) return tryOne(SOURCES[0] + name);
  return (await tryOne(RAWB + name)) || (await tryOne(PAGES + name)) || (await tryApi(name));
}
/* GitHub API contents with ETag revalidation (cache:"no-cache"): the browser sends If-None-Match, an unchanged file answers 304 (free, not counted against
   the 60 req/h unauthenticated limit) and a changed one is served within ~1 s of the publisher's commit. raw.githubusercontent.com ignores query strings and
   keeps a file cached for 5 min, so it is only the fallback. */
async function tryApi(name) {
  if (Date.now() < apiOKAt) return null;
  try {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 12000);
    const r = await fetch(APIB + name + "?ref=data", { cache: "no-cache", signal: ac.signal, headers: { Accept: "application/vnd.github.raw" } });
    clearTimeout(tm);
    const rem = +r.headers.get("x-ratelimit-remaining"), rst = +r.headers.get("x-ratelimit-reset");
    if (r.status === 403 || r.status === 429) { apiOKAt = rst ? rst * 1000 + 1000 : Date.now() + 15 * 60000; return null; }
    if (r.ok) { if (r.headers.has("x-ratelimit-remaining") && rem < 6 && rst) apiOKAt = rst * 1000 + 1000; return await r.json(); }
  } catch (e) {}
  return null;
}
const apiWindow = () => { const h = etHour(); return Q.get("api") === "1" || h < 8.75 || h >= 23.9; };
async function getState() {
  if (Q.get("data")) return tryOne(SOURCES[0] + "app-data.json");
  let best = apiWindow() ? await tryApi("app-data.json") : null;
  if (!best || Date.now() / 1000 - best.generated_at > 150) {
    const got = [best, ...(await Promise.all([tryOne(RAWB + "app-data.json"), tryOne(PAGES + "app-data.json")]))].filter(Boolean).sort((x, y) => y.generated_at - x.generated_at);
    best = got[0] || null;
  }
  return best;
}
const norm = r => ({ seq: r[0], ts: r[1], stage: r[2], item: r[3], decision: r[4], reason: r[5], v: r[6] || {} });
async function loadEvents(d, fresh) {
  const f = fresh && !Q.get("data") && apiWindow() ? ((await tryApi(d.events_file)) || await getJSON(d.events_file)) : await getJSON(d.events_file);
  return f ? f.rows.map(norm).filter(e => e.stage !== "server") : [];
}
async function poll(first) {
  const d = await getState();
  if (!d) { offline = true; dirty = true; return; }
  offline = false; lastFetchOK = Date.now();
  const newNight = D && D.night !== d.night;
  D = d; CFG = d.cfg || CFG;
  if (first || newNight) {
    EV = await loadEvents(d);
    if (d.tail.length && d.tail[0][0] > (EV.length ? EV[EV.length - 1].seq : 0) + 1) EV = await loadEvents(d, true);   // cached events file is older than the tail: fetch the fresh one
    mergeTail(d.tail);
    S = null; cur = 0; buildCoinChips(); seek(EV.length, false);
    const sk = parseFloat(Q.get("seek")); if (!isNaN(sk)) { mode = "pause"; seek(Math.round(EV.length * sk), false); }
    if (Q.get("replay")) { speed = +Q.get("speed") || 60; if (!GAPS[speed]) speed = Object.keys(GAPS).map(Number).reduce((a, b) => Math.abs(b - speed) < Math.abs(a - speed) ? b : a); seek(0, false); mode = "replay"; nextAt = 0; }
  } else {
    const had = EV.length; const last = had ? EV[had - 1].seq : 0;
    if (d.tail.length && d.tail[0][0] > last + 1 && had && Date.now() - lastEvFetch > 45000) { lastEvFetch = Date.now(); EV = await loadEvents(d, true); mergeTail(d.tail); if (cur > EV.length) cur = EV.length; }
    else mergeTail(d.tail);
  }
  dirty = true;
}
function mergeTail(tail) {
  let last = EV.length ? EV[EV.length - 1].seq : 0;
  for (const r of tail || []) if (r[0] > last && r[2] !== "server") { EV.push(norm(r)); last = r[0]; }
}

/* ---------- Kraken WS (public prices) ---------- */
let ws, wsTry = 0;
function connectWS() {
  if (!CFG.coins.length) return;
  try { ws = new WebSocket("wss://ws.kraken.com/v2"); } catch (e) { return; }
  ws.onopen = () => { wsOK = true; wsTry = 0; dirty = true; ws.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: CFG.coins.map(c => c.ws) } })); };
  ws.onmessage = m => {
    let j; try { j = JSON.parse(m.data); } catch (e) { return; }
    if (j.channel !== "ticker" || !j.data) return;
    for (const d of j.data) {
      const c = CFG.coins.find(c => c.ws === d.symbol); if (!c) continue;
      const prev = LIVE[c.name] && LIVE[c.name].last; LIVE[c.name] = { last: d.last, bid: d.bid, pct: d.change_pct };
      priceTick(c.name, prev);
    }
  };
  ws.onclose = ws.onerror = () => { wsOK = false; dirty = true; ws = null; setTimeout(connectWS, Math.min(30000, 2000 * ++wsTry)); };
}

/* ---------- UI ---------- */
const V = {};   // cached element refs
function mk(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function build() {
  $("#v-overview").innerHTML = `
  <div class="strip" id="strip">${[...ST.map(s => [s.k, s.k === "posmgr" ? "Positions" : s.name, s.c]), ["sup", "Supervisor", "var(--indigo)"]].map(a => `<button class="sc idle" id="sc-${a[0]}" style="--ac:${a[2]}" aria-label="${a[1]} agent, open Agents tab"><span class="sn"><i></i>${a[1]}</span><b>0</b><em></em></button>`).join("")}</div>
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
    <div class="spd">${[1, 10, 60, 300].map(x => `<button data-s="${x}">${x}x</button>`).join("")}</div>
    <div class="scrub"><button class="stp" data-st="-1" aria-label="Step back one event"><svg viewBox="0 0 12 12"><path d="M2 1h1.6v10H2zM11 1v10L4.5 6z"/></svg></button><input type="range" class="scr" min="0" max="0" value="0"><button class="stp" data-st="1" aria-label="Step forward one event"><svg viewBox="0 0 12 12"><path d="M8.4 1H10v10H8.4zM1 1l6.5 5L1 11z"/></svg></button><span class="evc">event 0 / 0</span></div>
  </div>
  <div class="vt"><span class="agents-hint" id="ahint"></span><button id="cmp" aria-pressed="false"><svg viewBox="0 0 12 12"><path d="M1 1h4v4H1zM7 1h4v4H7zM1 7h4v4H1zM7 7h4v4H7z"/></svg>Compact</button></div>
  <div id="agents">${ST.map(s => `<div class="agent idle" id="ag-${s.k}" style="--ac:${s.c}"><div class="ic"><svg viewBox="0 0 24 24">${s.ic}</svg></div><div class="bd"><div class="nm">${s.name}<small>${s.role}</small></div><div class="doing">Waiting…</div></div><div class="pillo">IDLE</div><div class="mini" id="mini-${s.k}"></div><div class="det" id="det-${s.k}"></div></div>`).join("")}
  <div class="agent idle" id="ag-sup" style="--ac:var(--indigo)"><div class="ic"><svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3.5"/></svg></div><div class="bd"><div class="nm">Supervisor<small>workers, restarts &amp; publisher</small></div><div class="doing">Waiting…</div></div><div class="pillo">—</div><div class="mini" id="mini-sup"></div><div class="det" id="det-sup"></div></div></div>`;
  $("#v-activity").innerHTML = `
  <div class="ctl">
    <div class="seg"><button data-m="pause"><svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>Pause</button><button data-m="live"><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4"/></svg>Live</button><button data-m="replay"><svg viewBox="0 0 12 12"><path d="M3 1l8 5-8 5z"/></svg>Replay</button></div>
    <div class="spd">${[1, 10, 60, 300].map(x => `<button data-s="${x}">${x}x</button>`).join("")}</div>
    <div class="scrub"><button class="stp" data-st="-1" aria-label="Step back one event"><svg viewBox="0 0 12 12"><path d="M2 1h1.6v10H2zM11 1v10L4.5 6z"/></svg></button><input type="range" class="scr" min="0" max="0" value="0"><button class="stp" data-st="1" aria-label="Step forward one event"><svg viewBox="0 0 12 12"><path d="M8.4 1H10v10H8.4zM1 1l6.5 5L1 11z"/></svg></button><span class="evc">event 0 / 0</span></div>
  </div>
  <div class="h"><span>Log</span></div>
  <div class="logbox"><div class="lh"><span>logger.tail <em id="log-n"></em></span><span id="log-st">● live</span></div><div class="log" id="log"></div><button id="log-more" hidden></button></div>
  <div class="h"><span>Funnel</span><span class="mono" id="fun-n" style="letter-spacing:0;text-transform:none"></span></div>
  <div class="card fun" id="fun"></div>`;
  $("#v-trades").innerHTML = `<div id="tr-sum" class="h"></div><div id="tr-open"></div><div class="h" id="tr-ch"><span>Closed</span></div><div id="tr-closed"></div>`;
  for (const b of document.querySelectorAll(".seg button")) b.onclick = () => setMode(b.dataset.m);
  for (const h of document.querySelectorAll(".agent")) h.onclick = e => { if (e.target.closest(".det") || COMPACT) return; h.classList.toggle("fold"); };
  $("#cmp").onclick = () => setCompact(!COMPACT);
  setCompact(COMPACT, true);
  for (const b of document.querySelectorAll(".spd button")) b.onclick = () => { speed = +b.dataset.s; nextAt = 0; dirty = true; };
  for (const b of document.querySelectorAll(".stp")) b.onclick = () => step(+b.dataset.st);
  for (const r of document.querySelectorAll(".scr")) r.oninput = e => { if (mode === "live" || mode === "replay") mode = "pause"; seek(+e.target.value, true); };
  $("#log-more").onclick = () => { logShow += 300; dirty = true; };
  for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => tab(b.dataset.tab);
  for (const b of document.querySelectorAll("#strip .sc")) b.onclick = () => tab("agents");
}
let COMPACT = Q.get("compact") ? Q.get("compact") === "1" : (() => { try { return localStorage.getItem("ct-compact") === "1"; } catch (e) { return false; } })();
function setCompact(on, init) {
  COMPACT = !!on; if (!init) { try { localStorage.setItem("ct-compact", on ? "1" : "0"); } catch (e) {} }
  $("#agents").classList.toggle("compact", COMPACT); $("#cmp").classList.toggle("on", COMPACT); $("#cmp").setAttribute("aria-pressed", COMPACT);
  $("#ahint").textContent = COMPACT ? "tonight's counts · tap Compact to expand" : "big numbers = tonight · small = all-time · tap a card to fold";
  dirty = true; if (!init) window.scrollTo(0, 0);
}
function setMode(m) {
  if (m === "replay") { if (mode !== "pause" || cur >= EV.length) { seek(0, false); } mode = "replay"; nextAt = 0; }
  else if (m === "live") { mode = "live"; nextAt = 0; if (EV.length - cur > 400) seek(EV.length, true); }
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
  for (const sc of document.querySelectorAll(".scr")) { if (+sc.max !== EV.length) sc.max = EV.length; if (document.activeElement !== sc || mode !== "pause") sc.value = cur; }
  for (const el of document.querySelectorAll(".evc")) setT(el, `event ${cur} / ${EV.length}`);
  for (const b of document.querySelectorAll(".stp")) b.disabled = +b.dataset.st < 0 ? cur <= 0 : cur >= EV.length;
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.m === mode);
  for (const b of document.querySelectorAll(".spd button")) b.classList.toggle("on", +b.dataset.s === speed);
  for (const el of document.querySelectorAll(".spd")) el.classList.toggle("off", mode !== "replay");
  const nopen = Object.keys(S.pos).length, now = perf();
  for (const s of ST) {
    const el = $("#ag-" + s.k), ev = S.last[s.k], act = S.at[s.k] && now - S.at[s.k] < 1800;
    const doing = ev ? describe(ev) : "Waiting for the first event…";
    if (setT(el.querySelector(".doing"), doing) && S.at[s.k] && now - S.at[s.k] < 600) flash(el);
    el.classList.toggle("active", !!act); el.classList.toggle("idle", !act);
    const stopped = ev && ev.item === "sys" && ev.decision === "stop";
    setT(el.querySelector(".pillo"), stopped ? "STOPPED" : act ? s.act : !ev ? "WAITING" : s.k === "posmgr" ? (nopen ? "WATCHING " + nopen : "FLAT") : "IDLE");
  }
  renderStrip(nopen, now); renderAgentDetails(); renderFunnel(); renderLog(); renderTrades();
}

/* ---------- agent cards: counters, reason bars, sparklines (all derived from the events up to the replay cursor) ---------- */
const PV = {}, nf = n => (+n || 0).toLocaleString("en-CA");
const SHORT = { btc_filter: "BTC below 1h EMA50", trend: "Trend not aligned", move_band: "24h move out of band", "no_signal: volume below 1.2x": "Volume below 1.2×",
  "no_signal: candle not green": "Candle not green", cooldown: "Cooldown after a loss", "signal candle already traded": "Candle already traded",
  "paused: consecutive-loss limit hit tonight": "Losing-streak pause", "daily loss halt": "Daily loss stop", chase: "Chase cap", "max open positions reached": "Max positions",
  "ranked below the free slots (weaker 24h move)": "Ranked below free slots", below_min_order: "Below min order", "order already pending/open for this pair": "Order already pending" };
const short = r => SHORT[r] || label(r);
const EXITL = { stop_loss: "Initial stop", trailing_stop: "Trailing stop", stop_breakeven_lock: "Break-even lock", time_exit_0800ET: "08:00 time exit", stale_outside_window: "Stale / outside window" };
const mergeM = (a, b) => { const o = { ...(a || {}) }; for (const k in b || {}) o[k] = (o[k] || 0) + b[k]; return o; };
function supList() {
  const ref = (mode === "live" && cur >= EV.length) ? 1e12 : (S.lastEv ? S.lastEv.ts : 0);
  return ((D && D.sup) || []).filter(x => x[0] <= ref);
}
function totals() {
  const sl = supList().filter(x => x[2] === "restart");
  return { scans: S.btcPass + S.btcBlock, btc_block: S.btcBlock, checks: S.chk, held: S.held, cands: S.cands, f_in: S.passed + S.fRej, f_pass: S.passed, f_rej: S.fRej, f_reasons: S.rej.filter,
    r_in: S.rin, r_ok: S.approved, r_rej: S.rRej, r_reasons: S.rej.risk, sent: S.sent, filled_b: S.buys, filled_s: S.wins + S.losses, failed: S.failed, stops: S.stops, be: S.be, holds: S.holds,
    wins: S.wins, losses: S.losses, pnl: S.pnl, restarts: sl.length, errors: S.errors, _sup: sl };
}
function allOf(T) {
  const P = (D && D.prior) || {}, A = {};
  for (const k in T) A[k] = (T[k] && typeof T[k] === "object" && !Array.isArray(T[k])) ? mergeM(P[k], T[k]) : (typeof T[k] === "number" ? (P[k] || 0) + T[k] : T[k]);
  A.nights = (P.nights || 0) + 1; return A;
}
function cell(key, val, lab, all, col, raw) {
  const v = String(val), ch = PV[key] !== undefined && PV[key] !== v && mode !== "pause"; PV[key] = v;
  return `<div class="c${ch ? " bump" : ""}"><b${col ? ` style="color:${col}"` : ""}>${esc(v)}</b><i>${raw != null ? esc(raw) : all != null ? "all " + esc(all) : "&nbsp;"}</i><span>${esc(lab)}</span></div>`;
}
const cells = a => `<div class="cells">${a.join("")}</div>`;
function split(parts, legend) {   // parts: [[n, color]]; legend: [[text,color]]
  const tot = parts.reduce((a, p) => a + p[0], 0);
  return `<div class="sb">${tot ? parts.map(p => `<i style="width:${p[0] / tot * 100}%;background:${p[1]}"></i>`).join("") : ""}</div><div class="sbl">${legend.map(l => `<span style="color:${l[1] || ""}">${esc(l[0])}</span>`).join("")}</div>`;
}
const sec = (t, r) => `<div class="sec"><span>${esc(t)}</span><span>${r ? esc(r) : ""}</span></div>`;
function rows(list, max, col, keep) {   // [[label, n, all]] non-zero first; zeros collapsed in one line. keep=true: fixed order, every row shown
  const nz = keep ? list : list.filter(x => x[1] > 0), z = keep ? [] : list.filter(x => !(x[1] > 0));
  let h = (keep ? nz : nz.sort((a, b) => b[1] - a[1])).map(x => `<div class="rr${x[1] > 0 ? "" : " z"}"><span>${esc(x[0])}</span><span><b>${nf(x[1])}</b>${x[2] != null && x[2] !== x[1] ? `<em> / ${nf(x[2])}</em>` : ""}</span><i class="f" style="width:${Math.min(100, x[1] / Math.max(1, max) * 100)}%;background:${col}"></i></div>`).join("");
  if (z.length) h += `<div class="rr z"><span>none yet · ${esc(z.map(x => x[0]).join(" · "))}</span></div>`;
  return h;
}
function kv(a) { return `<div class="kv">${a.map(x => `<div>${esc(x[0])}<b${x[2] ? ` style="color:${x[2]}"` : ""}>${esc(x[1])}</b></div>`).join("")}</div>`; }
function spark(stage, col) {
  const sp = (S.spark[stage]) || {}, end = S.lastEv ? Math.floor(S.lastEv.ts / 600) : 0, N = 36; let mx = 1, bars = "";
  for (let i = 0; i < N; i++) mx = Math.max(mx, sp[end - N + 1 + i] || 0);
  for (let i = 0; i < N; i++) { const n = sp[end - N + 1 + i] || 0, h = n ? Math.max(2, n / mx * 22) : 1; bars += `<rect x="${i * 4}" y="${24 - h}" width="3" height="${h}" rx="1" fill="${n ? col : "#222"}"${i === N - 1 ? ' opacity=".9"' : ""}/>`; }
  const t0 = (end - N + 1) * 600;
  return `<div class="spark"><svg viewBox="0 0 144 24" preserveAspectRatio="none">${bars}</svg><div class="sl"><span>${S.lastEv ? hms(t0).slice(0, 5) : ""}</span><span>events / 10 min</span><span>${S.lastEv ? hms(S.lastEv.ts).slice(0, 5) : ""}</span></div></div>`;
}
const lastLine = k => { const e = S.last[k]; return e && e.item !== "sys" ? `<div class="last"><b>${hms(e.ts)}</b> ${esc(describe(e))}</div>` : `<div class="last dim">no decision yet${e ? " · worker up since " + hms(e.ts) : ""}</div>`; };
function medInterval() {
  const t = S.scanTs, d = []; for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] < 600 && t[i] > t[i - 1]) d.push(t[i] - t[i - 1]);
  if (!d.length) return null; d.sort((a, b) => a - b); return d[d.length >> 1];
}
function renderMini(T, nopen, age, lr) {
  const bar = p => { const t = p.reduce((a, x) => a + x[0], 0); return `<div class="sb">${t ? p.map(x => `<i style="width:${x[0] / t * 100}%;background:${x[1]}"></i>`).join("") : ""}</div>`; };
  const m = (k, a, b) => setH($("#mini-" + k), cells(a.map((x, i) => cell("m." + k + i, x[0], x[1], null, x[2]))) + bar(b));
  const filled = T.filled_b + T.filled_s, pend = Math.max(0, T.sent - filled - T.failed), liveEnd = mode === "live" && cur >= EV.length;
  m("scout", [[nf(T.scans), "scans", "var(--blue)"], [nf(T.checks), "coins"], [nf(T.cands), "found", T.cands ? "var(--orange)" : ""]], [[T.cands, "var(--orange)"], [S.chk - S.cands, "#2d4b73"]]);
  m("filter", [[nf(T.f_in), "received", "var(--orange)"], [nf(T.f_pass), "accepted", T.f_pass ? "var(--green)" : ""], [nf(T.f_rej), "rejected", T.f_rej ? "var(--red)" : ""]], [[T.f_pass, "var(--green)"], [T.f_rej, "var(--red)"]]);
  m("risk", [[nf(T.r_ok), "cleared", T.r_ok ? "var(--green)" : ""], [nf(T.r_rej), "blocked", T.r_rej ? "var(--red)" : ""], [`${nopen}/${CFG.max_positions}`, "slots"]], [[T.r_ok, "var(--green)"], [T.r_rej, "var(--red)"]]);
  m("executor", [[nf(filled), "filled", filled ? "var(--green)" : ""], [nf(T.failed), "failed", T.failed ? "var(--red)" : ""], [nf(pend), "pending"]], [[filled, "var(--green)"], [T.failed, "var(--red)"], [pend, "var(--yellow)"]]);
  m("posmgr", [[nopen, "open", nopen ? "var(--green)" : ""], [`${T.wins}-${T.losses}`, "W-L"], [sg(T.pnl, 2), "P&L", T.pnl > 0.0005 ? "var(--green)" : T.pnl < -0.0005 ? "var(--red)" : ""]], [[T.wins, "var(--green)"], [T.losses, "var(--red)"]]);
  m("sup", [[nf(T.restarts), "restarts", T.restarts ? "var(--orange)" : "var(--green)"], [liveEnd && age != null ? (age < 90 ? Math.round(age) + "s" : ago(age).replace(" ago", "")) : S.lastEv ? hms(S.lastEv.ts).slice(0, 5) : "—", liveEnd ? "beat" : "last ev."], [nf(T.errors), "errors", T.errors ? "var(--red)" : ""]], []);
}
function renderAgentDetails() {
  if (!isOpenView("agents")) return;
  const T = totals(), A = allOf(T), R = CFG.rules || {}, C = CFG.currency, nopen = Object.keys(S.pos).length;
  const liveEnd = mode === "live" && cur >= EV.length;
  const stg = (D && D.state && D.state.stages) || {}, qs = (D && D.state && D.state.queues) || {};
  // ---- scout
  { const iv = medInterval(), nb = S.chk - S.cands, rate = iv ? (iv >= 90 ? Math.round(iv / 60) + "m" : Math.round(iv) + "s") : "—";
    let h = cells([cell("sc.scans", nf(T.scans), "scans", nf(A.scans), "var(--blue)"), cell("sc.chk", nf(T.checks), "coins checked", nf(A.checks)), cell("sc.cand", nf(T.cands), "candidates", nf(A.cands), T.cands ? "var(--orange)" : ""), cell("sc.rate", rate, "per scan", null, "", CFG.coins.length + " coins/scan")]);
    h += split([[S.cands, "var(--orange)"], [nb, "#2d4b73"]], [[`${nf(S.cands)} breakout${S.cands == 1 ? "" : "s"}`, "var(--orange)"], [`${nf(nb)} no breakout`, "var(--blue)"]]);
    const rw = [["No breakout above 24h high", nb]];
    if (S.nsF) rw.push(["…trend aligned (EMA20 > EMA50)", S.nsF - S.ns.trend], ["…volume ≥ 1.2×", S.nsF - S.ns.vol], ["…candle green", S.nsF - S.ns.red]);
    h += sec("Pre-screen of coin checks") + rows(rw, Math.max(nb, 1), "var(--blue)", true);
    const sc = T.scans; h += `<div class="rr"><span>BTC gate closed in</span><span><b class="${S.btcBlock ? "r" : "g"}">${nf(S.btcBlock)}</b><em> of ${nf(sc)} scans${sc ? " · " + Math.round(S.btcBlock / sc * 100) + "%" : ""}</em></span></div>`;
    const cl = Object.entries(S.coin).filter(([c, x]) => x.gap != null && !x.held).sort((a, b) => a[1].gap - b[1].gap).slice(0, 3);
    if (cl.length) h += sec("Closest to a breakout") + `<div class="chp">${cl.map(([c, x]) => `<span><b>${esc(c)}</b> ${x.gap <= 0 ? "breaking out" : x.gap.toFixed(1) + "% below"}</span>`).join("")}</div>`;
    const lc = S.lastCoin; h += lc ? `<div class="last"><b>${hms(lc.ts)}</b> last checked <b class="w">${esc(lc.coin)}</b> · ${sg(lc.move ?? 0, 1)}% 24h · vol ${(lc.vol ?? 0).toFixed(2)}×${lc.gap != null && !lc.cand ? " · " + lc.gap.toFixed(1) + "% below 24h high" : ""}</div>` : '<div class="last dim">no coin checked yet</div>';
    h += sec("Activity", "last 6h") + spark("scout", "var(--blue)");
    setH($("#det-scout"), h); }
  // ---- filter
  { const rej = S.rej.filter, ar = A.f_reasons || {}, ord = ["btc_filter", "trend", "move_band", "no_signal: volume below 1.2x", "no_signal: candle not green", "cooldown", "signal candle already traded"];
    const keys = [...ord, ...Object.keys(rej).filter(k => !ord.includes(k)), ...Object.keys(ar).filter(k => !ord.includes(k) && !(k in rej))];
    const pct = T.f_in ? Math.round(T.f_pass / T.f_in * 100) + "%" : "—";
    let h = cells([cell("fi.in", nf(T.f_in), "received", nf(A.f_in), "var(--orange)"), cell("fi.ok", nf(T.f_pass), "accepted", nf(A.f_pass), T.f_pass ? "var(--green)" : ""), cell("fi.rej", nf(T.f_rej), "rejected", nf(A.f_rej), T.f_rej ? "var(--red)" : ""), cell("fi.pct", pct, "accept rate", A.f_in ? Math.round(A.f_pass / A.f_in * 100) + "%" : null)]);
    h += split([[T.f_pass, "var(--green)"], [T.f_rej, "var(--red)"]], [[`${nf(T.f_pass)} accepted`, "var(--green)"], [`${nf(T.f_rej)} rejected`, "var(--red)"]]);
    h += sec("Rejection reasons", "tonight / all-time") + rows(keys.map(k => [short(k), rej[k] || 0, A.f_reasons ? ar[k] || 0 : null]), Math.max(1, ...Object.values(rej)), "var(--orange)");
    if (!T.f_in) h += `<div class="note">No candidates have reached the filter tonight — ${S.chk ? `all ${nf(S.chk - S.cands)} coin checks stopped at Scout's breakout check` : "Scout hasn't found a breakout yet"}.</div>`;
    h += sec("BTC gate (checked every scan)") + (S.btc ? kv([["Gate", S.btc.ok ? "OPEN" : "CLOSED", S.btc.ok ? "var(--green)" : "var(--red)"], ["BTC vs 1h EMA50", sg(S.btc.pct ?? 0, 2) + "%", S.btc.ok ? "var(--green)" : "var(--red)"]]) : '<div class="dim" style="font-size:12px">waiting for the first scan</div>');
    h += lastLine("filter") + sec("Activity", "last 6h") + spark("filter", "var(--orange)");
    setH($("#det-filter"), h); }
  // ---- risk
  { const rej = S.rej.risk, ar = A.r_reasons || {}, ord = ["paused: consecutive-loss limit hit tonight", "daily loss halt", "chase", "max open positions reached", "ranked below the free slots (weaker 24h move)", "below_min_order", "order already pending/open for this pair"];
    const keys = [...ord, ...Object.keys(rej).filter(k => !ord.includes(k)), ...Object.keys(ar).filter(k => !ord.includes(k) && !(k in rej))];
    const eq = equity(), maxp = CFG.max_positions, slotsUsed = nopen;
    let h = cells([cell("rk.in", nf(T.r_in), "received", nf(A.r_in), "var(--red)"), cell("rk.ok", nf(T.r_ok), "approved", nf(A.r_ok), T.r_ok ? "var(--green)" : ""), cell("rk.rej", nf(T.r_rej), "blocked", nf(A.r_rej), T.r_rej ? "var(--red)" : ""), cell("rk.slot", `${slotsUsed}/${maxp}`, "slots used")]);
    h += split([[T.r_ok, "var(--green)"], [T.r_rej, "var(--red)"]], [[`${nf(T.r_ok)} approved`, "var(--green)"], [`${nf(T.r_rej)} blocked${S.rDef ? " · " + S.rDef + " deferred" : ""}`, "var(--red)"]]);
    h += sec("Block reasons", "tonight / all-time") + rows(keys.map(k => [k === "chase" ? `Chase cap (>${R.max_chase_pct ?? 3}%)` : short(k), rej[k] || 0, A.r_reasons ? ar[k] || 0 : null]), Math.max(1, ...Object.values(rej)), "var(--red)");
    const stopC = CFG.start_capital * CFG.daily_stop_pct / 100, used = Math.max(0, -S.pnl), mc = R.max_consecutive_losses ?? 2;
    h += sec("Limits & sizing now") + kv([
      ["Entry size", `${CFG.risk_pct}% equity ≈ ${(eq * CFG.risk_pct / 100).toFixed(2)} ${C}`], ["Memes (DOGE, PEPE)", `${CFG.risk_pct_meme ?? 5}% ≈ ${(eq * (CFG.risk_pct_meme ?? 5) / 100).toFixed(2)} ${C}`],
      ["Stop", `${R.atr_stop_mult ?? 2}×ATR · ${R.stop_min_pct ?? 2}–${R.stop_max_pct ?? 6}% (memes ${R.stop_max_pct_meme ?? 8}%)`], ["Trail / break-even", `${R.trail_atr_mult ?? 2.5}×ATR / +${R.breakeven_arm_atr ?? 1.5}×ATR`],
      ["Loss streak", `${S.streak} / ${mc}${S.paused ? " · PAUSED" : ""}`, S.paused ? "var(--orange)" : ""], ["Day P&L vs stop", `${sg(S.pnl)} / −${stopC.toFixed(2)} ${C}${S.halted ? " · HALT" : ""}`, S.halted ? "var(--red)" : ""],
      ["Last approved size", S.lastSize != null ? `${S.lastSize.toFixed(2)} ${C}` : "—"], ["Chase cap", `${R.max_chase_pct ?? 3}% above the signal close`]]);
    h += split([[Math.min(used, stopC), used >= stopC ? "var(--red)" : "var(--orange)"], [Math.max(0, stopC - used), "#26262a"]], [[`daily stop used ${(Math.min(used, stopC) / stopC * 100).toFixed(0)}%`, ""]]);
    h += lastLine("risk") + sec("Activity", "last 6h") + spark("risk", "var(--red)");
    setH($("#det-risk"), h); }
  // ---- executor
  { const filled = T.filled_b + T.filled_s, pend = Math.max(0, T.sent - filled - T.failed), fl = S.lastFill;
    let h = cells([cell("ex.sent", nf(T.sent), "orders sent", nf(A.sent), "var(--green)"), cell("ex.fill", nf(filled), "filled", nf(A.filled_b + A.filled_s), filled ? "var(--green)" : ""), cell("ex.fail", nf(T.failed), "failed", nf(A.failed), T.failed ? "var(--red)" : ""), cell("ex.pend", nf(pend), "pending")]);
    h += split([[filled, "var(--green)"], [T.failed, "var(--red)"], [pend, "var(--yellow)"]], [[`${nf(filled)} filled`, "var(--green)"], [`${nf(T.failed)} failed`, "var(--red)"], [`${nf(pend)} pending`, "var(--yellow)"]]);
    h += sec("Orders", "tonight / all-time") + rows([["Buys sent (approved by Risk)", T.r_ok, A.r_ok], ["Sells sent (exit signals)", S.sentSell, null], ["Buys filled", T.filled_b, A.filled_b], ["Sells filled", T.filled_s, A.filled_s], ["Rejected / errors", T.failed, A.failed]], Math.max(1, T.sent, T.filled_b), "var(--green)", true);
    h += kv([["Mode", "PAPER · simulated fills"], ["Queue now", liveEnd && qs.exec ? `${qs.exec.ready} ready · ${qs.exec.claimed} claimed` : liveEnd ? "—" : "live only"]]);
    h += fl ? `<div class="last"><b>${hms(fl.ts)}</b> ${esc(describe(fl))}</div>` : '<div class="last dim">no fills yet</div>';
    h += sec("Activity", "last 6h") + spark("executor", "var(--green)");
    setH($("#det-executor"), h); }
  // ---- position manager
  { const open = Object.values(S.pos);
    let h = cells([cell("pm.open", nopen, "open now", null, nopen ? "var(--green)" : ""), cell("pm.chk", nf(T.holds), "pos. checks", nf(A.holds)), cell("pm.stop", nf(T.stops), "stop moves", nf(A.stops), T.stops ? "var(--yellow)" : ""), cell("pm.wl", `${T.wins}-${T.losses}`, "wins–losses", `${A.wins}-${A.losses}`)]);
    h += `<div class="pnl"><span>Closed P&L</span><b class="${T.pnl > 0.0005 ? "g" : T.pnl < -0.0005 ? "r" : "dim"}">${sg(T.pnl)} ${C}</b><em>all ${sg(A.pnl)} ${C}</em></div>`;
    h += split([[T.wins, "var(--green)"], [T.losses, "var(--red)"]], [[`${T.wins} win${T.wins == 1 ? "" : "s"}`, "var(--green)"], [`${T.losses} loss${T.losses == 1 ? "" : "es"}`, "var(--red)"]]);
    h += sec("Stop moves tonight") + rows([["Trailing stop raised", S.trail], ["Break-even lock armed", S.be]], Math.max(1, S.trail, S.be), "var(--yellow)", true);
    const ex = Object.entries(S.exitWhy); h += sec("Exits tonight") + (ex.length ? rows(ex.map(([k, n]) => [EXITL[k] || label(k), n]), Math.max(1, ...ex.map(x => x[1])), "var(--yellow)") : '<div class="rr z"><span>none yet</span></div>');
    if (open.length) h += sec("Open positions") + open.map(p => { const px = liveEnd && LIVE[p.coin] ? LIVE[p.coin].bid || LIVE[p.coin].last : p.bid, pc = (px / p.entry - 1) * 100, sd = (px / p.stop - 1) * 100;
      return `<div class="rr"><span><b class="w">${esc(p.coin)}</b> <em>${esc(p.kind)} stop ${fmtP(p.stop)} · ${sd.toFixed(1)}% away</em></span><b class="${pc >= 0 ? "g" : "r"}">${sg(pc)}%</b></div>`; }).join("");
    h += lastLine("posmgr") + sec("Activity", "last 6h") + spark("posmgr", "var(--yellow)");
    setH($("#det-posmgr"), h); }
  // ---- supervisor / publisher
  { const sl = T._sup, byW = {}; for (const x of sl) byW[x[1]] = (byW[x[1]] || 0) + 1;
    const nstart = Object.values(S.starts).reduce((a, b) => a + b, 0), lr = sl[sl.length - 1], ages = Object.values(stg).map(x => x.age_s).filter(x => x != null),
      age = D && ages.length ? Date.now() / 1000 - D.generated_at + Math.min(...ages) : null;
    const hb = k => { const x = stg[k], ev = S.last[k]; return [SBY[k].name, liveEnd && x ? `${x.state || "ok"} · last event ${ev ? hms(ev.ts) : "—"}` : ev ? `last event ${hms(ev.ts)}` : "—"]; };
    let h = cells([cell("su.rs", nf(T.restarts), "restarts", nf(A.restarts), T.restarts ? "var(--orange)" : "var(--green)"), cell("su.st", nf(nstart), "worker starts"), cell("su.er", nf(T.errors), "errors", nf(A.errors), T.errors ? "var(--red)" : ""), cell("su.hb", liveEnd && age != null ? (age < 90 ? Math.round(age) + "s" : ago(age).replace(" ago", "")) : "—", "last heartbeat")]);
    const bw = Object.entries(byW).filter(x => x[0]).map(([w, n]) => [SBY[w] ? SBY[w].name : w, n]);
    h += sec("Restarts by worker") + (bw.length ? rows(bw, Math.max(...bw.map(x => x[1])), "var(--orange)") : '<div class="rr z"><span>no restarts in this night</span></div>');
    h += sec("Workers") + kv(ST.map(s => hb(s.k)));
    h += sec("Publisher") + kv([["Last publish", D ? fD.format(new Date(D.generated_at * 1000)) + " ET" : "—"], ["Data up to event", D ? "#" + D.last_seq : "—"], ["Events loaded", nf(EV.length)], ["Source", Q.get("data") ? "demo file" : "GitHub (every ~1 min)"]]);
    h += lr ? `<div class="last"><b>${hms(lr[0])}</b> ${esc(lr[3])}</div>` : '<div class="last dim">no restarts</div>';
    setH($("#det-sup"), h);
    renderMini(T, nopen, age, lr);
    const el = $("#ag-sup"), act = T.restarts && lr && S.lastEv && S.lastEv.ts - lr[0] < 300;
    setT(el.querySelector(".doing"), lr ? `${lr[3]} · ${hms(lr[0])}` : "All workers running · no restarts"); el.classList.toggle("active", !!act); el.classList.toggle("idle", !act);
    setT(el.querySelector(".pillo"), T.restarts ? `${T.restarts} RESTART${T.restarts == 1 ? "" : "S"}` : "STABLE"); }
}
function renderStrip(nopen, now) {
  if (!isOpenView("overview")) return;
  const T = totals(), filled = T.filled_b + T.filled_s, lr = T._sup[T._sup.length - 1];
  const v = { scout: [nf(T.scans), "scans"], filter: [nf(T.f_pass), "accepted"], risk: [nf(T.r_ok), "cleared"], executor: [nf(filled), "filled"], posmgr: [nf(nopen), "open"], sup: [nf(T.restarts), "restarts"] };
  for (const k in v) {
    const el = $("#sc-" + k); if (!el) continue;
    const act = k === "sup" ? (T.restarts && lr && S.lastEv && S.lastEv.ts - lr[0] < 300) : (S.at[k] && now - S.at[k] < 1800);
    el.classList.toggle("active", !!act); el.classList.toggle("idle", !act);
    const b = el.querySelector("b"), ch = b._x !== undefined && b._x !== v[k][0] && mode !== "pause"; setT(b, v[k][0]); if (ch) { b.classList.remove("bump"); void b.offsetWidth; b.classList.add("bump"); }
    setT(el.querySelector("em"), v[k][1]);
  }
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
let logShow = 300;
const logRow = (e, cls) => { const L = LOGS[e.stage] || [e.stage, "#888"]; return `<div${cls ? ` class="${cls}"` : ""}><span class="t">${hms(e.ts)}</span> <span class="s" style="color:${L[1]}">${esc(L[0])}</span>${esc(describe(e))}</div>`; };
function renderLog() {
  if (!isOpenView("activity")) return;
  const box = $("#log"), all = S.log, tail = all.slice(-logShow), lastE = tail[tail.length - 1];
  const key = (lastE ? lastE.seq : 0) + ":" + tail.length + ":" + logShow + ":" + mode;
  if (box._k === key) return; box._k = key;
  const nearEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40, first = box._seq == null;
  const ix = box._seq != null && box._sh === logShow ? tail.findIndex(e => e.seq === box._seq) : -1;
  if (ix >= 0) {
    if (ix < tail.length - 1) { box.insertAdjacentHTML("beforeend", tail.slice(ix + 1).map(e => logRow(e, "new")).join("")); while (box.children.length > logShow) box.firstChild.remove(); }
  } else box.innerHTML = tail.map(e => logRow(e)).join("") || '<div class="dim">no events yet</div>';
  box._seq = lastE ? lastE.seq : null; box._sh = logShow;
  if (nearEnd || first || ix < 0) box.scrollTop = box.scrollHeight;
  setT($("#log-n"), `· ${nf(all.length)} lines${all.length > tail.length ? " · last " + nf(tail.length) : ""}`);
  const mo = $("#log-more"); mo.hidden = all.length <= tail.length; if (!mo.hidden) setT(mo, `Show ${Math.min(300, all.length - tail.length)} earlier lines`);
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
setInterval(() => { if (!document.hidden) poll(false); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(false); });
if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !Q.get("nosw")) navigator.serviceWorker.register("sw.js").catch(() => {});

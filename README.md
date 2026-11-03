# Copy Trader desk (PAPER)

Phone dashboard (PWA) for the Copy Trader paper night bot. Simulated money only; no keys or secrets in this repo.

- `main` branch = the static app (served by GitHub Pages).
- `data` branch = `app-data.json` + `events-<night>.json`, refreshed by the bot's publisher during the night (00:00–08:30 ET).
- `?data=demo/` previews the app with a **synthetic** demo night.


## v8 - CAD + USD wallets
Two paper wallets, never converted: CAD (BTC ETH SOL XRP DOGE PEPE, CAD pairs) and USD (ADA LINK AVAX LTC DOT SHIB, USD pairs). The Wallet tab shows the total as `CAD x + USD y`, then each wallet's balance, holdings and transactions. Events are tagged with `wallet`/`ccy`; money fields are generic (`size`, `cost`, `pnl`, `proceeds`) with legacy `*_cad` aliases on CAD-wallet events.

## v9 — live holdings value
Wallet tab and Overview now value open holdings at live Kraken prices (WebSocket plus a 7 s public REST Ticker poll as backup; CAD pairs for the CAD wallet, USD pairs for the USD wallet). Per holding: qty, avg entry, live price, live value, unrealised P&L ($ and %). Per wallet: cash + holdings = equity. Replay/pause value at event prices at the cursor and say so. Demo mode simulates small price ticks. SW cache ct-v9.

## v10 — updates reach the installed app on one open
App shell (index.html, app.js, styles.css) is served network-first by the service worker (revalidated, cache is only an offline / >6 s fallback). `sw.js` is registered with `updateViaCache:"none"`; the page calls `reg.update()` on load, on return to foreground, and every 30 min, and reloads once on `controllerchange` (15 s loop guard). A one-time bridge in `activate` reloads open pages that were running the old stale-while-revalidate versions (ct-v1..v9). Header shows the running version (v10). SW cache ct-v10.

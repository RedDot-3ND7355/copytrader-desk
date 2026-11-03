# Copy Trader desk (PAPER)

Phone dashboard (PWA) for the Copy Trader paper night bot. Simulated money only; no keys or secrets in this repo.

- `main` branch = the static app (served by GitHub Pages).
- `data` branch = `app-data.json` + `events-<night>.json`, refreshed by the bot's publisher during the night (00:00–08:30 ET).
- `?data=demo/` previews the app with a **synthetic** demo night.


## v8 - CAD + USD wallets
Two paper wallets, never converted: CAD (BTC ETH SOL XRP DOGE PEPE, CAD pairs) and USD (ADA LINK AVAX LTC DOT SHIB, USD pairs). The Wallet tab shows the total as `CAD x + USD y`, then each wallet's balance, holdings and transactions. Events are tagged with `wallet`/`ccy`; money fields are generic (`size`, `cost`, `pnl`, `proceeds`) with legacy `*_cad` aliases on CAD-wallet events.

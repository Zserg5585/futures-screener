# Futures Screener

Real-time Binance Futures screener with order book density analysis, signal detection, and charting.

## Architecture

```
futures-screener/
├── server/           # Node.js Fastify API (port 3200)
│   ├── index.js      # Main server, routes, Binance API integration
│   ├── signals.js    # Signal engine (vol_spike, liq_sweep, oi_div, funding_squeeze)
│   ├── liq-sweep.js  # Liquidity sweep detection (swing-only, volume gate)
│   ├── densityV2.js  # Order book density V2 (adaptive buckets, σ walls)
│   ├── ws.js         # WebSocket manager (Binance market streams)
│   ├── auth.js       # JWT auth + Google OAuth
│   ├── push.js       # Web Push notifications (VAPID)
│   ├── state.js      # In-memory state management
│   ├── klines-cache.js # Kline cache layer
│   └── modules/      # Binance API wrapper, density detector/tracker
├── app/              # Frontend (vanilla JS, no framework)
│   ├── index.html    # SPA entry
│   ├── app.js        # Core UI logic
│   ├── mini-charts.js # LWC v5 charts (259KB, main visualization)
│   ├── signals.js    # Signal UI
│   ├── settings.js   # Settings panel (30+ options)
│   ├── drawing-manager.js # Chart drawing tools
│   └── sw.js         # Service Worker (push + caching)
├── data/             # SQLite DBs (signals, push_subscriptions)
└── docs/             # VISION, ROADMAP, UI-SPEC, STATUS
```

## Quick Start

```bash
cd /home/app/futures-screener
npm test              # Run smoke tests
node server/index.js  # Start server (or PM2: futures-screener)
```

## Key Commands

- **Start:** `pm2 start futures-screener`
- **Logs:** `pm2 logs futures-screener --lines 50`
- **Test:** `npm test`
- **Lint:** `npx eslint server/ --ext .js` (if configured)

## Tech Stack

- **Backend:** Fastify 5, better-sqlite3, jsonwebtoken, ws, web-push
- **Frontend:** Vanilla JS, TailwindCSS, lightweight-charts v5
- **Data:** Binance Futures REST + WebSocket (FAPI, public endpoints)
- **Deploy:** PM2, Nginx reverse proxy, Let's Encrypt SSL
- **Domain:** `futures-screener.szhub.space`

## Code Conventions

- `const` > `let`, never `var`
- async/await everywhere
- Response format: `{ success: true, data: {} }`
- Logs: `[ISO timestamp]` prefix
- No frameworks on frontend — vanilla JS with DOM manipulation

## Signal Types

| Signal | Logic | Confidence |
|--------|-------|-----------|
| vol_spike | Volume ≥5x 20-period avg | 40-100 |
| liq_sweep | Swing level + volume gate + OI drop | 35-100 |
| oi_divergence | Price/OI divergence (exhaustion/accumulation) | 40-100 |
| oi_funding_squeeze | OI spike + extreme funding (contrarian) | 40-100 |

## Important Context

- **Rate Limiter:** 3-tier Binance protection (soft 1800, hard 2200, pause on 429/418)
- **WebSocket:** `/market/stream` endpoint (not legacy `/stream`)
- **Frontend caching:** Memory → IndexedDB → Server (3-tier)
- **Signals are server-side** — client only filters/displays
- **No tests existed before** — `tests/` directory is new

## Environment Variables

See `.env.example` — key ones: `JWT_SECRET`, `VAPID_*`, `PORT` (default 3200)

## Recent Major Changes

- LWC v5 migration (chart API changes)
- Keltner + Regression channel overlays
- Liq Sweep V2 (swing-only, volume gate ≥5x)
- 3-tier IndexedDB cache + infinite scroll
- Web Push (VAPID, server-side filtering)

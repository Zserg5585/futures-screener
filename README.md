# Futures Screener 📊

Fast visual screener for order book densities on Binance Futures (USDT-M). Shows large limit levels near current mark price, sorts and highlights "MM" (market maker) levels with high liquidity strength.

## Features

- 🚀 Real-time order book density analysis
- 📊 MM (Market Maker) level detection with clustering
- 📈 Volume and NATR indicators for each symbol
- ⭐ Watchlist with localStorage persistence
- 📱 Mobile-first responsive UI (cards + desktop table)
- ⚡ Auto-refresh with configurable intervals (5s, 10s, 20s)
- 🔍 Filters: minNotional, windowPct, xFilter, natrFilter
- 🌐 Fastify backend with in-memory caching (3s TTL)

## Architecture

- **server/** — Node.js + Fastify API (port 3200)
- **app/** — Static HTML/JS/CSS (no bundler)
- **Binance API** — FAPI (Futures API)

## Quick Start

```bash
cd /home/app/futures-screener
pm2 delete futures-screener 2>/dev/null || true
PORT=3200 pm2 start npm --name "futures-screener" -- run dev
pm2 logs futures-screener
```

Open http://127.0.0.1:3200 in your browser.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/symbols` | All USDT-PERP symbols |
| GET | `/depth/:symbol` | Order book depth |
| GET | `/densities/simple` | **Main endpoint** — densities with MM flag |
| GET | `/_cache/stats` | Server cache stats |

### `/densities/simple` Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `symbols` | (all) | Comma-separated (e.g. `BTCUSDT,ETHUSDT`) |
| `minNotional` | `0` | Minimum notional (price × qty) |
| `depthLimit` | `100` | Max levels to return |
| `windowPct` | `5.0` | Window around price (±%) |
| `concurrency` | `5` | Parallel requests to Binance |
| `xFilter` | `0` | Filter by x multiplier (0 = no filter) |
| `natrFilter` | `0` | Filter by NATR (0 = no filter) |
| `mmMode` | `false` | Show only MM levels |
| `mmMultiplier` | `4` | MM candidate multiplier |

### Response Structure

```json
{
  "count": 200,
  "minNotional": 0,
  "depthLimit": 100,
  "concurrency": 5,
  "mmMode": false,
  "windowPct": 5.0,
  "xFilter": 0,
  "natrFilter": 0,
  "data": [
    {
      "symbol": "BTCUSDT",
      "side": "bid",
      "price": 72500.00,
      "qty": 10.5,
      "notional": 761250,
      "distancePct": 0.15,
      "x": 2.35,
      "mmCount": 3,
      "score": 4.1234,
      "vol1": 1500000,
      "vol2": 1200000,
      "vol3": 980000,
      "natr": 0.45,
      "mmBaseBid": 350000,
      "mmBaseAsk": 380000
    }
  ]
}
```

## Scoring Formula

```
score = log10(1 + notional) × exp(-distancePct / 0.45) × (isMM ? 1.8 : 1)
```

- `notional`: Order size (price × quantity)
- `distancePct`: Distance from mark price (%)
- `isMM`: Flag based on cluster analysis

## MM Detection Logic

1. **Base calculation**: 70th percentile of notionals (filtered by base × 2)
2. **MM candidate**: level.notional ≥ base × mmMultiplier (default 4x)
3. **Clustering**: Group levels within 0.2% gap, min 2 levels, min 20k total notional
4. **mmBase**: 50th percentile of cluster totals (if ≥ 3 clusters)
5. **x multiplier**: level.notional / mmBase

## Project Structure

```
futures-screener/
├── server/
│   └── index.js       # Fastify API
├── app/
│   ├── index.html     # Main HTML
│   ├── app.js         # UI logic
│   └── styles.css     # Tailwind styles
├── docs/
│   ├── VISION.md      # Long-term goals
│   ├── ROADMAP.md     # Development stages
│   └── UI-SPEC.md     # UI specification
├── package.json
├── README.md          # This file
├── CRITICAL_ISSUES.md # Bug fixes history
└── MEMORY.md          # Long-term memory
```

## Current Status

- ✅ Phase 0: MVP — **Complete**
  - API `/densities/simple` working
  - Scoring, sorting, MM flag
  - UI: table + cards, auto-refresh
- ✅ Phase 1: Features — **Complete**
  - Watchlist (localStorage)
  - Filters (xFilter, natrFilter)
  - Mobile-first responsive UI
- ⏳ Phase 2: UX & Analytics — **Next**
  - Mini-charts (Chart.js integration)
  - Signals tab (triggers)
  - Export to CSV
  - Telegram alerts

## Tech Stack

- **Backend**: Node.js 18+, Fastify
- **Frontend**: Vanilla JS, Tailwind CSS
- **Data**: Binance Futures REST API (FAPI)
- **Caching**: In-memory (3s TTL)
- **Process Manager**: PM2

## Deployment

### Systemd Service

```bash
sudo cp futures-screener.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable futures-screener
sudo systemctl start futures-screener
```

### Nginx Proxy (with SSL)

```nginx
server {
    listen 443 ssl http2;
    server_name futures-screener.szhub.space;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | Server port |
| `MM_SEED_MULTIPLIER` | `2.0` | MM candidate multiplier (initial) |
| `SERVICE_NAME` | `futures-screener` | Service name for healthcheck |

### Binance API

No API key required — public endpoints only.

## Development

```bash
# Run locally (no PM2)
cd server
node index.js

# Run tests (if added)
npm test

# Type check (if migrated to TS)
npm run type-check
```

## Links

- [Vision](docs/VISION.md) — Long-term goals
- [Roadmap](docs/ROADMAP.md) — Development stages
- [UI Spec](docs/UI-SPEC.md) — UI specification
- [Critical Issues](CRITICAL_ISSUES.md) — Bug fixes
- [Memory](MEMORY.md) — Long-term memory

## Author

Created for OpenClaw by Morty 🦞

## License

MIT

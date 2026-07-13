# RB Live Engine

Standalone Node.js + TypeScript backend that streams live market data from **Angel One SmartAPI** into **Supabase** for the Ratan Bullion platform. Runs 24×7 as a container or Node process. Writes to Supabase only — the frontend (Ratan Connect Hub) is not touched.

## Features

- Pluggable **provider architecture** (Angel One shipped; add REST/WS providers without touching the engine)
- Angel One SmartAPI: login + TOTP, JWT + Feed Token, binary WebSocket v2 stream
- Automatic reconnect + resubscribe, heartbeats, exponential backoff
- Tick pipeline: validate → normalize → timestamp → queue → fan-out
- Writers for `public.rates`, `public.rates_history`, `public.market_candles`
- 1-minute OHLC candles today; 5m / 15m / 30m / 1h / 1d wired for later
- `GET /health` endpoint with connection + tick + DB status
- Structured logs via `pino` (JSON in prod, pretty in dev)

## Requirements

- Node.js 20+
- A Supabase project with tables `rates`, `rates_history`, `market_candles` already provisioned
- Angel One SmartAPI credentials (API key, client code, PIN, TOTP secret)

## Local run

```bash
cp .env.example .env
# fill in credentials
npm install
npm run dev
```

Health check:

```bash
curl http://localhost:8080/health
```

## Production build

```bash
npm run build
npm start
```

## Docker

```bash
docker build -t rb-live-engine .
docker run --env-file .env -p 8080:8080 rb-live-engine
```

## Deployment notes

- **Render / Railway / Fly.io**: deploy as a long-running web service, expose port `8080`, mount env vars, enable auto-restart. Fly/Railway are a good fit because they don't idle the process.
- **VPS / bare metal**: run under `systemd` or `pm2` with `--restart-on-failure`.
- Do **not** deploy this to Vercel/Netlify/Cloudflare Workers — a persistent WebSocket needs a long-running process.

## Adding a new provider

1. Create `src/providers/<name>/index.ts` implementing `MarketDataProvider` from `src/providers/types.ts`.
2. Register it in `src/providers/registry.ts`.
3. Configure via env; the engine picks it up without changes.

## Adding a new timeframe

Edit `ENABLED_TIMEFRAMES` in `.env` (e.g. `1m,5m,15m`). Definitions live in `src/engine/candles/timeframes.ts`.

## Environment variables

See `.env.example`. All secrets come from env — never commit `.env`.

## Project layout

```
src/
  config/     env loader (zod-validated)
  providers/  MarketDataProvider interface + Angel One implementation
  engine/     MarketEngine, pipeline, queue, candle aggregator
  services/   Supabase client + table writers + health server
  models/     Tick, Candle, Rate types
  utils/      logger, retry, time helpers
  index.ts    bootstrap
```

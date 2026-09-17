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

## Generic HTTP rate API (provider agnostic)

The engine can ingest Gold/Silver prices from **any** HTTP JSON API. No provider
name, URL or response shape is hardcoded — switching providers is a pure
environment-variable change, no code edit and no redeploy of new logic.

Layers:

- `src/providers/genericapi/httpClient.ts` — configurable URL, GET/POST, timeout
  and auth (`none` / `query` / `header` / `bearer`).
- `src/providers/genericapi/parser.ts` — normalizes any response into
  `{ gold: { bid, ask, high, low }, silver: {...}, timestamp }`.
- `src/services/GenericRateService.ts` — polls, validates, rejects stale/invalid
  responses and feeds normalized ticks into the existing RB rate pipeline
  (same metal IDs, premium/spread, high/low and `updated_at` behaviour).

Supported response shapes (one generic parser):

```jsonc
// array + symbol lookup       -> RATE_API_ITEMS_PATH=data, GOLD_SYMBOL=India Gold, GOLD_BID_PATH=bid
{ "data": [ { "symbol": "India Gold", "bid": 151156, "ask": 151200 } ] }

// object keyed by metal       -> GOLD_BID_PATH=gold.bid
{ "gold": { "bid": 151156 }, "silver": { "bid": 232617 } }

// nested single price         -> GOLD_PRICE_PATH=result.gold.price
{ "result": { "gold": { "price": 151156 } } }

// array by index              -> GOLD_BID_PATH=data[0].bid
{ "data": [ { "bid": 151156 }, { "bid": 232617 } ] }
```

Safety: API keys are read from environment variables only and are never logged;
invalid, zero, non-numeric, empty or stale responses are rejected and the last
valid rates are retained; API failures never crash the engine and never affect
the Angel One MCX feed, candles or expiry logic. Status is exposed on `/health`
under `api`, `gold` and `silver`.

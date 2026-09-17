# RB Live Engine

Standalone Node.js + TypeScript backend that polls a **generic HTTP rate API** and writes live Gold/Silver rates into **Supabase** for the Ratan Bullion platform. Runs 24×7 as a container or Node process. Writes to Supabase only — the frontend (Ratan Connect Hub) is not touched.

There is exactly one live rate source: the configurable generic API. No broker feed, no WebSocket, no secondary price provider.

## Architecture

```
Generic HTTP API
  ↓  src/providers/genericapi/httpClient.ts   (URL, method, auth, timeout)
Generic API Parser
  ↓  src/providers/genericapi/parser.ts       (symbol/path mapping)
Normalized Gold/Silver rate
  ↓  src/services/GenericRateService.ts       (poll, validate, reject stale)
MarketEngine pipeline
  ↓  validate → normalize → queue
Existing RB rate writer
  ↓  src/services/RatesWriter.ts              (premium/spread, high/low, updated_at)
Supabase `rates` (+ `rates_history`, `market_candles`)
  ↓
Ratan Bullion App
```

## Features

- Provider-agnostic HTTP client: configurable URL, `GET`/`POST`, timeout, and auth (`none` / `query` / `header` / `bearer`)
- Flexible response mapping: array + symbol lookup, nested objects, array indexes
- Rate pipeline: validate → normalize → timestamp → queue → fan-out
- Writers for `public.rates`, `public.rates_history`, `public.market_candles`
- 1-minute OHLC candles today; 5m / 15m / 30m / 1h / 1d wired for later
- `GET /health` with API, per-metal feed and Supabase write diagnostics (no secrets)
- Structured logs via `pino` (JSON in prod, pretty in dev)

## Requirements

- Node.js 20+
- A Supabase project with `rates`, `rates_history`, `market_candles` provisioned
- An HTTP Gold/Silver rate API and (optionally) its API key

## Local run

```bash
cp .env.example .env
# fill in Supabase + RATE_API_* values
npm install
npm run dev
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

Deploy as a long-running service (Railway / Render / Fly.io / VPS) on port `8080`.

## Switching rate providers

Change environment variables only — no code edit:

```bash
RATE_API_URL=https://your-provider/v1/rates
RATE_API_AUTH_TYPE=query        # none | query | header | bearer
RATE_API_KEY=...                # server-side only, never logged
RATE_API_KEY_NAME=api_key
RATE_API_ITEMS_PATH=data
RATE_API_SYMBOL_FIELD=symbol
GOLD_SYMBOL=India Gold
GOLD_BID_PATH=bid
SILVER_SYMBOL=India Silver
SILVER_BID_PATH=bid
```

Supported response shapes (one generic parser):

```jsonc
// array + symbol lookup  -> RATE_API_ITEMS_PATH=data, GOLD_SYMBOL=India Gold, GOLD_BID_PATH=bid
{ "data": [ { "symbol": "India Gold", "bid": 151156, "ask": 151200 } ] }

// object keyed by metal  -> GOLD_BID_PATH=gold.bid
{ "gold": { "bid": 151156 }, "silver": { "bid": 232617 } }

// nested single price    -> GOLD_PRICE_PATH=result.gold.price
{ "result": { "gold": { "price": 151156 } } }

// array by index         -> GOLD_BID_PATH=data[0].bid
{ "data": [ { "bid": 151156 }, { "bid": 232617 } ] }
```

## Safety

API keys live in environment variables only and are never logged or exposed to the frontend. Invalid, zero, non-numeric, empty or stale responses are rejected and the last valid rates are retained. API failures never crash the engine. Supabase updates that affect zero rows are treated as failures and retried.

## Project layout

```
src/
  config/     env loader (zod-validated)
  providers/  genericapi: httpClient, parser, path resolver, config
  engine/     MarketEngine, pipeline, queue, candle aggregator
  services/   Supabase client + table writers + health server + diagnostics
  models/     Tick, Candle, Rate types
  utils/      logger, retry, time helpers
  index.ts    bootstrap
```

## Environment variables

See `.env.example`. All secrets come from env — never commit `.env`.

## Instrument mapping (5 configurable sources)

Gold Future, Silver Future, USD-INR, USD Gold and USD Silver are mapped purely
from environment variables — no provider is referenced in code.

- Matching: `*_ID` (primary, needs `RATE_API_ID_FIELD`), `*_SYMBOL` (fallback).
  If both are configured and disagree, the instrument is rejected and the
  mismatch is reported in `/health` instead of silently picking a wrong item.
- Values: `*_PRICE_PATH` (LTP), `*_HIGH_PATH`, `*_LOW_PATH`. Bid/ask remain
  supported for backward compatibility but are not required.
- `/health` exposes `sources` with configured id/symbol, matched id/symbol,
  LTP/high/low, last successful fetch and any mapping error.

Gold and Silver continue to drive the existing RB rate pipeline, Supabase
persistence and the SSE stream unchanged; the USD sources are parsed and
surfaced in diagnostics.

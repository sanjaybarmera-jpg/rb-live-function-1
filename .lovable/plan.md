
# RB Live Engine — Standalone Market Data Backend

A self-contained Node.js + TypeScript service scaffolded under a new top-level `engine/` folder in this repo. Fully independent from the TanStack frontend — its own `package.json`, `tsconfig`, `Dockerfile`, and lockfile. You deploy it wherever you host Node (Render, Railway, Fly, VPS). Frontend code is not touched.

## What gets created

```text
engine/
├── package.json
├── tsconfig.json
├── Dockerfile
├── .dockerignore
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── index.ts                       # bootstrap: load config, start engine + health server
    ├── config/
    │   └── env.ts                     # zod-validated env loader
    ├── providers/
    │   ├── types.ts                   # MarketDataProvider interface + Tick model
    │   ├── registry.ts                # provider registry (pluggable)
    │   └── angelone/
    │       ├── index.ts               # AngelOneProvider (implements MarketDataProvider)
    │       ├── auth.ts                # login, JWT, feed token, TOTP (speakeasy)
    │       ├── websocket.ts           # WS v2 client, heartbeat, reconnect, resubscribe
    │       ├── decoder.ts             # binary tick decoder
    │       └── instruments.ts         # subscription list loader
    ├── engine/
    │   ├── MarketEngine.ts            # orchestrates provider(s) + pipeline
    │   ├── pipeline.ts                # validate → normalize → timestamp → enqueue
    │   ├── queue.ts                   # in-memory bounded queue w/ backpressure
    │   └── candles/
    │       ├── CandleAggregator.ts    # 1m OHLC now; timeframe-agnostic
    │       └── timeframes.ts          # 1m/5m/15m/30m/1h/1d definitions
    ├── services/
    │   ├── supabase.ts                # service-role client
    │   ├── RatesWriter.ts             # upsert public.rates
    │   ├── RatesHistoryWriter.ts      # insert public.rates_history
    │   ├── CandleWriter.ts            # upsert public.market_candles
    │   └── HealthServer.ts            # http GET /health
    ├── models/
    │   ├── Tick.ts
    │   ├── Candle.ts
    │   └── Rate.ts
    ├── utils/
    │   ├── logger.ts                  # pino logger → stdout + logs/
    │   ├── retry.ts                   # exponential backoff
    │   └── time.ts
    └── logs/                          # .gitkeep; runtime log files
```

## Provider abstraction

`MarketDataProvider` interface:

```text
connect(): Promise<void>
disconnect(): Promise<void>
subscribe(instruments: Instrument[]): Promise<void>
onTick(handler: (tick: Tick) => void): void
onStatus(handler: (s: ProviderStatus) => void): void
getStatus(): ProviderStatus
```

`AngelOneProvider` is the first implementation. Future providers (Metals API, MCX vendor, generic REST/WS) drop into `providers/` and register in `registry.ts` — engine code stays unchanged.

## Angel One module

- `auth.ts`: POST `/rest/auth/angelbroking/user/v1/loginByPassword` with clientcode, pin, TOTP (generated from `ANGEL_TOTP_SECRET` via `speakeasy`). Returns `jwtToken`, `feedToken`, `refreshToken`.
- `websocket.ts`: connects to `wss://smartapisocket.angelone.in/smart-stream` with headers `Authorization`, `x-api-key`, `x-client-code`, `x-feed-token`. Sends subscription frames for configured tokens/exchanges, ping every 30s, listens for binary ticks, exponential-backoff reconnect (1s → 30s cap), re-auths + resubscribes on reconnect.
- `decoder.ts`: parses the binary LTP / Quote / SnapQuote payloads to a normalized `Tick`.

## Pipeline

Each tick: `validate` (required fields, sane price/ts) → `normalize` (symbol mapping, units) → `timestamp` (server-received + exchange ts) → `enqueue`. A single async consumer drains the queue and fans out to writers + candle aggregator. Bounded queue drops oldest with a warn log if backpressure hits (prevents memory blowup during DB stalls).

## Supabase writers (schema untouched)

- `public.rates`: UPSERT on symbol — latest LTP, bid/ask, ts.
- `public.rates_history`: INSERT append-only per tick (optionally throttled to 1/sec/symbol via config).
- `public.market_candles`: UPSERT on (symbol, timeframe, bucket_start) — O/H/L/C/V updated as ticks arrive; finalized when bucket rolls over.

Uses `@supabase/supabase-js` with `SUPABASE_SERVICE_ROLE_KEY`. No schema migrations — assumes the tables already exist in the shared Ratan Connect Hub Supabase project.

## Candle engine

`CandleAggregator` keyed by `(symbol, timeframe)`. Ships with 1-minute enabled; 5m/15m/30m/1h/1d wired in `timeframes.ts` and gated by config flag `ENABLED_TIMEFRAMES`. Bucket rollover flushes final candle to `market_candles`.

## Health server

Minimal `node:http` server on `PORT` (default 8080), `GET /health` returns JSON:

```text
{
  connected, providerName, currentContract,
  lastTickTime, ticksReceived, dbStatus,
  reconnectCount, engineUptimeSec
}
```

## Logging

`pino` → pretty stdout in dev, JSON in prod, plus rolling file in `logs/`. Log events: startup, login OK/fail, WS connect/disconnect/reconnect, subscription ack, per-minute tick counter, DB write batches, errors, warnings.

## Error recovery

- WS disconnect → auto-reconnect with backoff → re-login if feed token expired → resubscribe stored instrument list.
- Supabase write failure → retry with backoff; persistent failure flips `dbStatus=false` in health without killing the engine.
- Uncaught exception / unhandled rejection → log + graceful shutdown (drains queue, closes WS) so container orchestrator restarts cleanly.

## Configuration (`.env.example`)

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ANGEL_API_KEY=
ANGEL_CLIENT_CODE=
ANGEL_PIN=
ANGEL_TOTP_SECRET=
ANGEL_INSTRUMENTS=          # comma list, e.g. "NSE:99926000,MCX:GOLDM24DECFUT"
ENABLED_TIMEFRAMES=1m
HISTORY_THROTTLE_MS=1000
PORT=8080
LOG_LEVEL=info
NODE_ENV=production
```

## Runtime & tooling

- Node 20, TypeScript 5, `tsx` for dev, `tsc` build → `dist/`.
- Deps: `@supabase/supabase-js`, `ws`, `axios`, `speakeasy`, `zod`, `pino`, `pino-pretty`, `dotenv`.
- Scripts: `dev`, `build`, `start`, `typecheck`, `lint`.
- `Dockerfile`: multi-stage (build → slim runtime), non-root user, `CMD ["node","dist/index.js"]`, `HEALTHCHECK` hitting `/health`.

## README covers

Local run (`cp .env.example .env && npm i && npm run dev`), Docker (`docker build -t rb-live-engine . && docker run --env-file .env -p 8080:8080 rb-live-engine`), deployment notes for Render/Railway/Fly, adding a new provider, adding a new timeframe.

## Explicit non-goals

- No changes to any file outside `engine/` — the TanStack frontend, `src/`, `package.json`, `vite.config.ts`, Supabase schema, and Lovable Cloud config all stay as-is.
- No Lovable Edge Function is created.
- No React, no UI, no browser code.

## Platform note

Lovable's preview host cannot run this service (serverless workers, no long-lived Node process). The scaffold lives in the repo so you can `cd engine/` and deploy it to any Node host. Iterating on it inside Lovable is fine; running it here is not.

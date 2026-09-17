import http from "node:http";
import { logger } from "../utils/logger.js";
import { getFeedDiagnostics } from "./feedDiagnostics.js";
import { getGenericApiDiagnostics } from "./GenericRateService.js";
import type { CustomerRate, RateBroadcaster } from "./RateBroadcaster.js";

export interface HealthSnapshot {
  connected: boolean;
  providerName: string;
  currentContract?: string;
  lastTickTime?: string;
  ticksReceived: number;
  dbStatus: boolean;
  reconnectCount: number;
  engineUptimeSec: number;
}
export type HealthProvider = () => HealthSnapshot;

export class HealthServer {
  private server: http.Server | null = null;

  constructor(
    private port: number,
    private snapshot: HealthProvider,
    private broadcaster?: RateBroadcaster,
    private allowedOrigins: string[] = [],
  ) {}

  start(): void {
    this.server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      const origin = req.headers.origin;
      const allowed = !origin || this.allowedOrigins.includes(origin);

      if (origin && allowed) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }

      if (path === "/stream" && req.method === "OPTIONS") {
        if (!allowed) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Cache-Control",
        });
        res.end();
        return;
      }

      if (path === "/stream" && req.method === "GET") {
        if (!this.broadcaster) {
          res.writeHead(503);
          res.end();
          return;
        }
        if (!allowed) {
          res.writeHead(403);
          res.end();
          return;
        }

        const before = this.broadcaster.subscriberCount;
        let unsubscribe: (() => void) | null = null;
        let heartbeat: NodeJS.Timeout | null = null;
        let closed = false;

        const cleanup = () => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          unsubscribe = null;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
        };

        const sendEvent = (event: "snapshot" | "rate", data: unknown): boolean => {
          try {
            if (res.destroyed || res.writableEnded) return false;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            return true;
          } catch {
            cleanup();
            return false;
          }
        };

        const onRate = (rate: CustomerRate): void => {
          if (!sendEvent("rate", rate)) {
            cleanup();
          }
        };

        unsubscribe = this.broadcaster.subscribe(onRate);

        if (this.broadcaster.subscriberCount === before) {
          unsubscribe?.();
          res.writeHead(503);
          res.end();
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        if (!sendEvent("snapshot", this.broadcaster.getSnapshot())) {
          cleanup();
          return;
        }

        heartbeat = setInterval(() => {
          try {
            if (res.destroyed || res.writableEnded) {
              cleanup();
              return;
            }
            res.write(": heartbeat\n\n");
          } catch {
            cleanup();
          }
        }, 15_000);
        heartbeat.unref?.();

        req.once("close", cleanup);
        res.once("close", cleanup);
        res.once("error", cleanup);

        return;
      }

      if (req.method === "GET" && (path === "/health" || path === "/healthz" || path === "/")) {
        const snap = this.snapshot();
        const api = getGenericApiDiagnostics();
        const feed = getFeedDiagnostics();
        const body = {
          status: "ok",
          ...snap,
          api: {
            ...api,
            last_success: api.lastSuccess ?? null,
            last_error: api.lastError ?? null,
            last_update: api.lastUpdate ?? null,
          },
          gold: {
            last_value: api.gold?.lastValue ?? feed.gold.lastLtp,
            last_update: api.gold?.lastUpdate ?? feed.gold.lastTickTime,
            high: api.gold?.high ?? null,
            low: api.gold?.low ?? null,
          },
          silver: {
            last_value: api.silver?.lastValue ?? feed.silver.lastLtp,
            last_update: api.silver?.lastUpdate ?? feed.silver.lastTickTime,
            high: api.silver?.high ?? null,
            low: api.silver?.low ?? null,
          },
          /*
           * All five configured sources: provider id/symbol matching, parsed
           * LTP/High/Low and the Supabase write status of the RB internal row.
           */
          sources: buildSources(api.instruments ?? {}, feed),
          supabase: {
            urlConfigured: Boolean(process.env["SUPABASE_URL"]),
            serviceRoleKeyConfigured: Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]),
          },
          feed,
          sse: {
            enabled: Boolean(this.broadcaster),
            connected_clients: this.broadcaster?.subscriberCount ?? 0,
          },
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body, null, 2));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    this.server.listen(this.port, "0.0.0.0", () => {
      logger.info({ port: this.port }, "[health] server listening");
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

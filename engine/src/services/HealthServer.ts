import http from "node:http";
import { logger } from "../utils/logger.js";
import { getFeedDiagnostics } from "./feedDiagnostics.js";
import { getGenericApiDiagnostics } from "./GenericRateService.js";
import type { RateBroadcaster } from "./RateBroadcaster.js";

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
        if (!allowed) { res.writeHead(403); res.end(); return; }
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Cache-Control",
        });
        res.end();
        return;
      }

      if (path === "/stream" && req.method === "GET") {
        if (!this.broadcaster?.enabled) { res.writeHead(503); res.end(); return; }
        if (!allowed) { res.writeHead(403); res.end(); return; }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        if (!this.broadcaster.addClient(res)) {
          res.end();
        }
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
          supabase: {
            urlConfigured: Boolean(process.env["SUPABASE_URL"]),
            serviceRoleKeyConfigured: Boolean(process.env["SUPABASE_SERVICE_ROLE_KEY"]),
          },
          feed,
          sse: {
            enabled: this.broadcaster?.enabled ?? false,
            connected_clients: this.broadcaster?.connectedClients ?? 0,
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
    this.broadcaster?.shutdown();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

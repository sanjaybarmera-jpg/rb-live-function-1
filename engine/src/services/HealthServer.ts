import http from "node:http";
import { logger } from "../utils/logger.js";
import { getFeedDiagnostics } from "./feedDiagnostics.js";
import { getGenericApiDiagnostics } from "./GenericRateService.js";


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
  ) {}

  start(): void {
    this.server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && (path === "/health" || path === "/healthz" || path === "/")) {
        const snap = this.snapshot();
        const api = getGenericApiDiagnostics();
        const feed = getFeedDiagnostics();
        // Additive, read-only discovery info — existing fields are untouched.
        const body = {
          status: "ok",
          ...snap,
          // Generic (provider-agnostic) HTTP rate API status.
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
            urlHost: (() => {
              try {
                return new URL(process.env["SUPABASE_URL"] ?? "").host;
              } catch {
                return null;
              }
            })(),
          },
          feed: getFeedDiagnostics(),
        };

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body, null, 2));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });
    // 0.0.0.0 is required so Railway's proxy/healthcheck can reach the process.
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

import http from "node:http";
import { logger } from "../utils/logger.js";

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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snap, null, 2));
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

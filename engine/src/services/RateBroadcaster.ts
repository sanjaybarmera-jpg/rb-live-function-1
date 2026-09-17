import type { ServerResponse } from "node:http";

export type Metal = "gold" | "silver";

export interface CustomerRate {
  metal: Metal;
  ltp: number;
  updated_at: string;
  [key: string]: unknown;
}

export interface RateSnapshot {
  gold?: CustomerRate;
  silver?: CustomerRate;
}

export interface RateBroadcasterOptions {
  heartbeatMs?: number;
  maxClients?: number;
}

/** Non-blocking, best-effort SSE fan-out for the final rate state. */
export class RateBroadcaster {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeatMs: number;
  private readonly maxClients: number;
  private latest: RateSnapshot | null = null;
  private sequence = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: RateBroadcasterOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.maxClients = options.maxClients ?? 5_000;
    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.broadcastHeartbeat(), this.heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  get snapshot(): RateSnapshot | null {
    return this.latest;
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  get enabled(): boolean {
    return !this.stopped;
  }

  addClient(response: ServerResponse): boolean {
    if (this.stopped || this.clients.size >= this.maxClients) return false;
    this.clients.add(response);
    const remove = () => this.removeClient(response);
    response.once("close", remove);
    response.once("error", remove);
    if (this.latest) this.send(response, "snapshot", this.latest);
    return true;
  }

  publish(rate: CustomerRate): void {
    if (this.stopped) return;
    const next: RateSnapshot = { ...(this.latest ?? {}), [rate.metal]: rate };
    if (JSON.stringify(next) === JSON.stringify(this.latest)) return;
    this.latest = next;
    const event = this.latest[rate.metal] === rate ? "rate" : "snapshot";
    this.broadcast(event, event === "rate" ? rate : next);
  }

  removeClient(response: ServerResponse): void {
    this.clients.delete(response);
  }

  shutdown(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) {
      try { client.end(); } catch { /* disconnected client */ }
    }
    this.clients.clear();
  }

  private broadcastHeartbeat(): void {
    if (this.stopped) return;
    const frame = `:\n\n`;
    for (const client of [...this.clients]) {
      if (!this.write(client, frame)) this.removeClient(client);
    }
  }

  private broadcast(event: "snapshot" | "rate", data: unknown): void {
    const frame = this.frame(event, data);
    for (const client of [...this.clients]) {
      if (!this.write(client, frame)) this.removeClient(client);
    }
  }

  private send(client: ServerResponse, event: "snapshot" | "rate", data: unknown): void {
    if (!this.write(client, this.frame(event, data))) this.removeClient(client);
  }

  private frame(event: string, data: unknown): string {
    return `event: ${event}\nid: ${++this.sequence}\ndata: ${JSON.stringify({ type: event, timestamp: new Date().toISOString(), data })}\n\n`;
  }

  private write(client: ServerResponse, value: string): boolean {
    try {
      if (client.destroyed || client.writableEnded) return false;
      client.write(value);
      return true;
    } catch { return false; }
  }
}

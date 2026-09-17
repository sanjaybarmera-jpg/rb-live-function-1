import type { ServerResponse } from "node:http";

export type Metal = "gold" | "silver";

export interface CustomerRate {
  metal: Metal;
  ltp: number;
  high: number;
  low: number;
  updated_at: string;
}

export interface RateSnapshot {
  gold?: CustomerRate;
  silver?: CustomerRate;
}

export interface RateBroadcasterOptions {
  heartbeatMs?: number;
  maxClients?: number;
}

/** Best-effort, non-blocking SSE fan-out for final customer-facing rates. */
export class RateBroadcaster {
  private readonly clients = new Set<ServerResponse>();
  private readonly maxClients: number;
  private readonly heartbeatMs: number;
  private latest: RateSnapshot | null = null;
  private sequence = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: RateBroadcasterOptions = {}) {
    this.maxClients = options.maxClients ?? 5000;
    this.heartbeatMs = options.heartbeatMs ?? 15000;
    if (this.heartbeatMs > 0) {
      this.heartbeat = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  get snapshot(): RateSnapshot | null { return this.latest; }
  get connectedClients(): number { return this.clients.size; }
  get maxClientCount(): number { return this.maxClients; }
  get enabled(): boolean { return !this.stopped; }

  addClient(response: ServerResponse): boolean {
    if (this.stopped || this.clients.size >= this.maxClients) return false;
    this.clients.add(response);
    const remove = () => this.removeClient(response);
    response.once("close", remove);
    response.once("error", remove);
    if (this.latest) this.writeClient(response, this.format("snapshot", this.latest));
    return this.clients.has(response);
  }

  publish(rate: CustomerRate): void {
    if (this.stopped) return;
    const previous = this.latest?.[rate.metal];
    if (previous && JSON.stringify(previous) === JSON.stringify(rate)) return;

    this.latest = { ...(this.latest ?? {}), [rate.metal]: { ...rate } };
    // Serialize once, then use the same immutable frame for every client.
    const frame = this.format("rate", rate);
    for (const client of [...this.clients]) {
      if (!this.writeClient(client, frame)) this.removeClient(client);
    }
  }

  removeClient(response: ServerResponse): void { this.clients.delete(response); }

  shutdown(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients) {
      try { client.end(); } catch { /* client already disconnected */ }
    }
    this.clients.clear();
  }

  private sendHeartbeat(): void {
    if (this.stopped) return;
    for (const client of [...this.clients]) {
      if (!this.writeClient(client, ":\n\n")) this.removeClient(client);
    }
  }

  private format(event: "snapshot" | "rate", data: unknown): string {
    const payload = JSON.stringify({ type: event, timestamp: new Date().toISOString(), data });
    return `event: ${event}\nid: ${++this.sequence}\ndata: ${payload}\n\n`;
  }

  private writeClient(client: ServerResponse, frame: string): boolean {
    try {
      if (client.destroyed || client.writableEnded) return false;
      client.write(frame);
      return true;
    } catch { return false; }
  }
}

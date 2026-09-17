/**
 * RB internal rate ids broadcast over SSE.
 * These are the Supabase `rates` row identifiers, never provider ids.
 */
export type Metal =
  | "gold"
  | "silver"
  | "usd_inr"
  | "usd_gold"
  | "usd_silver";

export interface CustomerRate {
  metal: Metal;
  ltp: number;
  high: number;
  low: number;
  updated_at: string;
}

export type RateSnapshot = Partial<Record<Metal, CustomerRate>>;

export type RateListener = (rate: CustomerRate) => void;

export const DEFAULT_MAX_SUBSCRIBERS = 5000;

/** Small, dependency-free in-memory broadcaster for customer-facing rates. */
export class RateBroadcaster {
  private latest: RateSnapshot = {};
  private readonly listeners = new Set<RateListener>();

  constructor(
    private readonly maxSubscribers: number = DEFAULT_MAX_SUBSCRIBERS,
  ) {}

  publish(rate: CustomerRate): void {
    const previous = this.latest[rate.metal];
    if (previous && this.isEqual(previous, rate)) return;

    const next = { ...rate };
    this.latest = { ...this.latest, [rate.metal]: next };

    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // A broken subscriber must not affect the remaining listeners.
      }
    }
  }

  getSnapshot(): RateSnapshot {
    return {
      gold: this.latest.gold && { ...this.latest.gold },
      silver: this.latest.silver && { ...this.latest.silver },
    };
  }

  subscribe(listener: RateListener): () => void {
    if (this.listeners.size >= this.maxSubscribers) {
      return () => undefined;
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  private isEqual(previous: CustomerRate, next: CustomerRate): boolean {
    return (
      previous.metal === next.metal &&
      previous.ltp === next.ltp &&
      previous.high === next.high &&
      previous.low === next.low &&
      previous.updated_at === next.updated_at
    );
  }
}

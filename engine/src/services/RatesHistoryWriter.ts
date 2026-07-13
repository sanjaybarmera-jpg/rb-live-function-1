import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";

/** Appends per-tick history to public.rates_history, throttled per-symbol. */
export class RatesHistoryWriter {
  private lastAt = new Map<string, number>();
  private lastError: string | null = null;

  constructor(private throttleMs: number) {}

  async write(tick: Tick): Promise<void> {
    if (this.throttleMs > 0) {
      const prev = this.lastAt.get(tick.symbol) ?? 0;
      if (tick.receivedTs - prev < this.throttleMs) return;
      this.lastAt.set(tick.symbol, tick.receivedTs);
    }
    const row = {
      symbol: tick.symbol,
      ltp: tick.ltp,
      bid: tick.bid ?? null,
      ask: tick.ask ?? null,
      volume: tick.volume ?? null,
      ts: toIso(tick.exchangeTs ?? tick.receivedTs),
    };
    const { error } = await getSupabase().from("rates_history").insert(row);
    if (error) {
      this.lastError = error.message;
      logger.error({ err: error.message, symbol: tick.symbol }, "[rates_history] insert failed");
      throw error;
    }
    this.lastError = null;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

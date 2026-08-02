import { logger } from "../utils/logger.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";
import { metalGroupForSymbol } from "./metals.js";

/** Appends tick history to public.rates_history, throttled per metal group. */
export class RatesHistoryWriter {
  private lastAt = new Map<string, number>();
  private lastError: string | null = null;

  constructor(private throttleMs: number) {}

  async write(tick: Tick): Promise<void> {
    const group = metalGroupForSymbol(tick.symbol);
    if (!group) return;

    if (this.throttleMs > 0) {
      const prev = this.lastAt.get(group) ?? 0;
      if (tick.receivedTs - prev < this.throttleMs) return;
      this.lastAt.set(group, tick.receivedTs);
    }

    const row = {
      metal_type: group,
      ltp: tick.ltp,
      open: tick.ltp,
      high: tick.ltp,
      low: tick.ltp,
      close: tick.ltp,
      provider: tick.provider,
    };
    const { error } = await getSupabase().from("rates_history").insert(row);
    if (error) {
      this.lastError = error.message;
      logger.error({ err: error.message, metal: group }, "[rates_history] insert failed");
      throw error;
    }
    this.lastError = null;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

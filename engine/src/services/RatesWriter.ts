import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";

/** UPSERTs the latest LTP/bid/ask into public.rates keyed by symbol. */
export class RatesWriter {
  private lastError: string | null = null;

  async write(tick: Tick): Promise<void> {
    const row = {
      symbol: tick.symbol,
      ltp: tick.ltp,
      bid: tick.bid ?? null,
      ask: tick.ask ?? null,
      ts: toIso(tick.exchangeTs ?? tick.receivedTs),
    };
    const { error } = await getSupabase()
      .from("rates")
      .upsert(row, { onConflict: "symbol" });
    if (error) {
      this.lastError = error.message;
      logger.error({ err: error.message, symbol: tick.symbol }, "[rates] upsert failed");
      throw error;
    }
    this.lastError = null;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

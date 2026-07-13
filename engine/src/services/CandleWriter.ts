import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Candle } from "../models/Candle.js";

/** UPSERTs candles into public.market_candles keyed by (symbol, timeframe, bucket_start). */
export class CandleWriter {
  private lastError: string | null = null;

  async write(candle: Candle): Promise<void> {
    const row = {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      bucket_start: toIso(candle.bucketStart),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    };
    const { error } = await getSupabase()
      .from("market_candles")
      .upsert(row, { onConflict: "symbol,timeframe,bucket_start" });
    if (error) {
      this.lastError = error.message;
      logger.error(
        { err: error.message, symbol: candle.symbol, tf: candle.timeframe },
        "[market_candles] upsert failed",
      );
      throw error;
    }
    this.lastError = null;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

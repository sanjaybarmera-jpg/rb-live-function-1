import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Candle } from "../models/Candle.js";
import { metalGroupForSymbol } from "./metals.js";

/** UPSERTs candles into public.market_candles keyed by (metal_type, timeframe, candle_time). */
export class CandleWriter {
  private lastError: string | null = null;

  async write(candle: Candle, provider = "angelone"): Promise<void> {
    const metalType = metalGroupForSymbol(candle.symbol);
    if (!metalType) return;

    const row = {
      metal_type: metalType,
      timeframe: candle.timeframe,
      candle_time: toIso(candle.bucketStart),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      provider,
    };
    const { error } = await getSupabase()
      .from("market_candles")
      .upsert(row, { onConflict: "metal_type,timeframe,candle_time" });
    if (error) {
      this.lastError = error.message;
      logger.error(
        { err: error.message, metal: metalType, tf: candle.timeframe },
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

import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Candle } from "../models/Candle.js";
import { metalGroupForSymbol } from "./metals.js";

/** Minimum gap between UPSERTs of the same still-open candle. */
const OPEN_CANDLE_THROTTLE_MS = 2_000;

/** UPSERTs candles into public.market_candles keyed by (metal_type, timeframe, candle_time). */
export class CandleWriter {
  private lastError: string | null = null;
  private lastWriteAt = new Map<string, number>();

  async write(candle: Candle, closed = false, provider = "angelone"): Promise<void> {
    const metalType = metalGroupForSymbol(candle.symbol);
    if (!metalType) {
      logger.warn(
        { symbol: candle.symbol },
        "[market_candles] no metal_type mapping for symbol — candle skipped (set METAL_TOKEN_MAP)",
      );
      return;
    }

    const key = `${metalType}|${candle.timeframe}|${candle.bucketStart}`;
    const now = Date.now();
    if (!closed) {
      const last = this.lastWriteAt.get(key) ?? 0;
      if (now - last < OPEN_CANDLE_THROTTLE_MS) return;
    }
    this.lastWriteAt.set(key, now);

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
    logger.debug({ row, closed }, "[market_candles] write");
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
    logger.debug(
      { metal: metalType, tf: candle.timeframe, candle_time: row.candle_time, closed },
      "[market_candles] upsert ok",
    );
    if (closed) this.lastWriteAt.delete(key);
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

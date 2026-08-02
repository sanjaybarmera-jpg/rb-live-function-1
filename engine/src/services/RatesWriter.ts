import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";

interface RateRow {
  symbol: string;
  ltp: number;
  bid: number | null;
  ask: number | null;
  ts: string;
}

const FLUSH_INTERVAL_MS = 250;

/**
 * Buffers the latest tick per symbol in memory and flushes them to
 * public.rates via UPSERT on a fixed interval. Duplicate ticks for the same
 * symbol within a flush window collapse into a single row.
 */
export class RatesWriter {
  private buffer = new Map<string, RateRow>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private lastError: string | null = null;

  constructor(private flushIntervalMs: number = FLUSH_INTERVAL_MS) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    logger.info({ flushIntervalMs: this.flushIntervalMs }, "[rates] buffered writer started");
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    logger.info("[rates] buffered writer stopped");
  }

  /** Non-blocking: records the latest tick for the symbol. */
  write(tick: Tick): void {
    this.buffer.set(tick.symbol, {
      symbol: tick.symbol,
      ltp: tick.ltp,
      bid: tick.bid ?? null,
      ask: tick.ask ?? null,
      ts: toIso(tick.exchangeTs ?? tick.receivedTs),
    });
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const rows = Array.from(this.buffer.values());
    this.buffer.clear();
    try {
      const { error } = await getSupabase()
        .from("rates")
        .upsert(rows, { onConflict: "symbol" });
      if (error) {
        this.lastError = error.message;
        logger.error({ err: error.message, count: rows.length }, "[rates] upsert failed");
        return;
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: this.lastError }, "[rates] flush failed");
    } finally {
      this.flushing = false;
    }
  }

  get pending(): number {
    return this.buffer.size;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

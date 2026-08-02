import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";
import {
  metalGroupForSymbol,
  metalTypesForGroup,
  type MetalGroup,
} from "./metals.js";

interface MetalState {
  group: MetalGroup;
  mcx_ltp: number;
  high: number;
  low: number;
  updated_at: string;
}

const FLUSH_INTERVAL_MS = 250;

/**
 * Buffers the latest tick per metal group in memory and flushes them to
 * public.rates on a fixed interval. Each flush updates only mcx_ltp, high,
 * low and updated_at for the rows matching the group's metal_type values.
 */
export class RatesWriter {
  private buffer = new Map<MetalGroup, MetalState>();
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

  /** Non-blocking: records the latest tick for the tick's metal group. */
  write(tick: Tick): void {
    const group = metalGroupForSymbol(tick.symbol);
    if (!group) return;
    const ts = toIso(tick.exchangeTs ?? tick.receivedTs);
    const prev = this.buffer.get(group);
    this.buffer.set(group, {
      group,
      mcx_ltp: tick.ltp,
      high: prev ? Math.max(prev.high, tick.ltp) : tick.ltp,
      low: prev ? Math.min(prev.low, tick.ltp) : tick.ltp,
      updated_at: ts,
    });
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const states = Array.from(this.buffer.values());
    this.buffer.clear();
    try {
      for (const state of states) {
        const { error } = await getSupabase()
          .from("rates")
          .update({
            mcx_ltp: state.mcx_ltp,
            high: state.high,
            low: state.low,
            updated_at: state.updated_at,
          })
          .in("metal_type", metalTypesForGroup(state.group) as string[]);
        if (error) {
          this.lastError = error.message;
          logger.error({ err: error.message, group: state.group }, "[rates] update failed");
          continue;
        }
        this.lastError = null;
      }
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

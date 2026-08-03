import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";
import {
  metalGroupForSymbol,
  metalTypesForGroup,
  type MetalGroup,
} from "./metals.js";
import { currentSessionKey, sessionKeyFor } from "./session.js";

interface SessionState {
  group: MetalGroup;
  /** IST trading-day key this high/low belongs to. */
  sessionKey: string;
  mcx_ltp: number;
  high: number;
  low: number;
  updated_at: string;
}

const FLUSH_INTERVAL_MS = 250;
const GROUPS: MetalGroup[] = ["gold", "silver"];

/**
 * Holds one persistent session state per metal group (gold, silver) and
 * flushes it to public.rates on a fixed interval.
 *
 * high/low are MCX *session* extremes: they survive every flush, are restored
 * from Supabase on restart, and reset exactly once when a new MCX trading
 * session begins. Only the flush cadence is buffered — never the extremes.
 */
export class RatesWriter {
  private sessions = new Map<MetalGroup, SessionState>();
  private dirty = new Set<MetalGroup>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private lastError: string | null = null;
  private initialized = false;

  constructor(private flushIntervalMs: number = FLUSH_INTERVAL_MS) {}

  /**
   * Restart safety: reload today's session high/low from public.rates when the
   * stored row still belongs to the current MCX session.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const key = currentSessionKey();
    for (const group of GROUPS) {
      const metalType = metalTypesForGroup(group)[0] as string;
      try {
        const { data, error } = await getSupabase()
          .from("rates")
          .select("mcx_ltp, high, low, updated_at")
          .eq("metal_type", metalType)
          .maybeSingle();
        if (error) {
          logger.warn({ err: error.message, group }, "[rates] session restore query failed");
          continue;
        }
        if (!data) continue;

        const updatedAt = data.updated_at ? Date.parse(data.updated_at as string) : NaN;
        const high = Number(data.high);
        const low = Number(data.low);
        if (
          !isFinite(updatedAt) ||
          sessionKeyFor(updatedAt) !== key ||
          !isFinite(high) ||
          !isFinite(low) ||
          high <= 0 ||
          low <= 0
        ) {
          logger.info(
            { group, sessionKey: key },
            "[rates] no usable session state in DB — waiting for first live tick",
          );
          continue;
        }

        this.sessions.set(group, {
          group,
          sessionKey: key,
          mcx_ltp: Number(data.mcx_ltp) || low,
          high,
          low,
          updated_at: toIso(updatedAt),
        });
        logger.info(
          { group, sessionKey: key, high, low },
          "[rates] session restored from DB",
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), group },
          "[rates] session restore failed",
        );
      }
    }
  }

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

  /** Non-blocking: folds the tick into the metal group's session state. */
  write(tick: Tick): void {
    const group = metalGroupForSymbol(tick.symbol);
    if (!group) return;

    const tsMs = tick.exchangeTs ?? tick.receivedTs;
    const key = sessionKeyFor(tsMs);
    const ts = toIso(tsMs);
    let state = this.sessions.get(group);

    if (!state) {
      state = { group, sessionKey: key, mcx_ltp: tick.ltp, high: tick.ltp, low: tick.ltp, updated_at: ts };
      this.sessions.set(group, state);
      logger.info(
        { group, sessionKey: key, high: state.high, low: state.low },
        "[rates] session initialized",
      );
      this.dirty.add(group);
      return;
    }

    if (state.sessionKey !== key) {
      logger.info(
        {
          group,
          previousSession: state.sessionKey,
          newSession: key,
          previousHigh: state.high,
          previousLow: state.low,
        },
        "[rates] new MCX session detected",
      );
      state.sessionKey = key;
      state.high = tick.ltp;
      state.low = tick.ltp;
      logger.info(
        { group, sessionKey: key, high: state.high, low: state.low },
        "[rates] session reset",
      );
    } else {
      if (tick.ltp > state.high) {
        state.high = tick.ltp;
        logger.info({ group, sessionKey: key, high: state.high }, "[rates] new session high");
      }
      if (tick.ltp < state.low) {
        state.low = tick.ltp;
        logger.info({ group, sessionKey: key, low: state.low }, "[rates] new session low");
      }
    }

    state.mcx_ltp = tick.ltp;
    state.updated_at = ts;
    this.dirty.add(group);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.dirty.size === 0) return;
    this.flushing = true;
    const groups = Array.from(this.dirty);
    this.dirty.clear();
    try {
      for (const group of groups) {
        const state = this.sessions.get(group);
        if (!state) continue;
        const { error } = await getSupabase()
          .from("rates")
          .update({
            mcx_ltp: state.mcx_ltp,
            high: state.high,
            low: state.low,
            updated_at: state.updated_at,
          })
          .in("metal_type", metalTypesForGroup(group) as string[]);
        if (error) {
          this.lastError = error.message;
          logger.error({ err: error.message, group }, "[rates] update failed");
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
    return this.dirty.size;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

import type { Tick } from "../models/Tick.js";

export function validateTick(tick: Tick): boolean {
  if (!tick.symbol) return false;
  if (typeof tick.ltp !== "number" || !isFinite(tick.ltp) || tick.ltp <= 0) return false;
  return true;
}

export function normalizeTick(tick: Tick): Tick {
  return {
    ...tick,
    symbol: tick.symbol.trim().toUpperCase(),
  };
}

export function stampTick(tick: Tick): Tick {
  return {
    ...tick,
    receivedTs: tick.receivedTs || Date.now(),
  };
}

/**
 * A tick is "stale" when the exchange timestamp lags wall-clock time by more
 * than maxAgeMs — typically the last trade replayed by the feed while the
 * market is closed. Such ticks must not open or update candles.
 * maxAgeMs <= 0 disables the check.
 */
export function isStaleTick(tick: Tick, maxAgeMs: number, now = Date.now()): boolean {
  if (maxAgeMs <= 0) return false;
  if (typeof tick.exchangeTs !== "number" || !isFinite(tick.exchangeTs)) return false;
  return now - tick.exchangeTs > maxAgeMs;
}

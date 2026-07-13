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

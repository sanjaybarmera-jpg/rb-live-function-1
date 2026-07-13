import type { Timeframe } from "../../models/Candle.js";

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function parseTimeframes(csv: string): Timeframe[] {
  const all: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "1d"];
  return csv
    .split(",")
    .map((s) => s.trim() as Timeframe)
    .filter((t): t is Timeframe => all.includes(t));
}

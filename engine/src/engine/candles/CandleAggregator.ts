import type { Candle, Timeframe } from "../../models/Candle.js";
import type { Tick } from "../../models/Tick.js";
import { bucketStart } from "../../utils/time.js";
import { TIMEFRAME_MS } from "./timeframes.js";

export type CandleUpdate = { candle: Candle; closed: boolean };
export type CandleListener = (update: CandleUpdate) => void;

/** Aggregates ticks into OHLC candles across configured timeframes. */
export class CandleAggregator {
  private open = new Map<string, Candle>(); // key = `${symbol}|${tf}`
  private listeners: CandleListener[] = [];

  constructor(private timeframes: Timeframe[]) {}

  onCandle(listener: CandleListener): void {
    this.listeners.push(listener);
  }

  ingest(tick: Tick): void {
    const ts = tick.exchangeTs ?? tick.receivedTs;
    for (const tf of this.timeframes) {
      const start = bucketStart(ts, TIMEFRAME_MS[tf]);
      const key = `${tick.symbol}|${tf}`;
      const existing = this.open.get(key);

      if (!existing || existing.bucketStart !== start) {
        // Close previous bucket if any
        if (existing) this.emit({ candle: existing, closed: true });
        const fresh: Candle = {
          symbol: tick.symbol,
          timeframe: tf,
          bucketStart: start,
          open: tick.ltp,
          high: tick.ltp,
          low: tick.ltp,
          close: tick.ltp,
          volume: tick.volume ?? 0,
          tickCount: 1,
        };
        this.open.set(key, fresh);
        this.emit({ candle: fresh, closed: false });
        continue;
      }

      existing.high = Math.max(existing.high, tick.ltp);
      existing.low = Math.min(existing.low, tick.ltp);
      existing.close = tick.ltp;
      if (typeof tick.volume === "number") existing.volume = tick.volume;
      existing.tickCount++;
      this.emit({ candle: existing, closed: false });
    }
  }

  private emit(u: CandleUpdate): void {
    for (const l of this.listeners) l(u);
  }
}

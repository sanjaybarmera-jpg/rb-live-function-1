export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "1d";

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  /** Bucket start (ms since epoch). */
  bucketStart: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Number of ticks aggregated into this candle so far. */
  tickCount: number;
}

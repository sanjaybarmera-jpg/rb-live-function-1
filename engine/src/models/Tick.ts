export interface Tick {
  /** Provider that produced the tick, e.g. "angelone". */
  provider: string;
  /** Normalized symbol used across the platform (e.g. "GOLDM24DECFUT"). */
  symbol: string;
  /** Raw exchange + token identifier, provider-specific. */
  instrumentId: string;
  /** Exchange code (e.g. NSE_FO, MCX_FO). */
  exchange: string;
  /** Last traded price. */
  ltp: number;
  bid?: number;
  ask?: number;
  volume?: number;
  /** Exchange-provided timestamp (ms since epoch), when available. */
  exchangeTs?: number;
  /** Time the engine received the tick (ms since epoch). */
  receivedTs: number;
}

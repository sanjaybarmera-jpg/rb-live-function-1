import type { Tick } from "../models/Tick.js";

export interface Instrument {
  exchangeType: number;
  token: string;
  /** Optional platform-normalized symbol (e.g. "GOLDM24DECFUT"). */
  symbol?: string;
}

export interface ProviderStatus {
  connected: boolean;
  providerName: string;
  lastTickTs?: number;
  ticksReceived: number;
  reconnectCount: number;
  currentContract?: string;
}

export type TickHandler = (tick: Tick) => void;
export type StatusHandler = (status: ProviderStatus) => void;

export interface MarketDataProvider {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(instruments: Instrument[]): Promise<void>;
  onTick(handler: TickHandler): void;
  onStatus(handler: StatusHandler): void;
  getStatus(): ProviderStatus;
  /**
   * Optional: resolve with the first valid, non-stale tick for a token.
   * Providers that do not implement it simply skip tick confirmation.
   */
  waitForTick?(token: string, timeoutMs: number): Promise<Tick>;
  /** Optional: last time any token produced a valid non-stale tick. */
  getLastValidTickTs?(): number | null;
}

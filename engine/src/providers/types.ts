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
}

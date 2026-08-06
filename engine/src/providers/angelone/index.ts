import { logger } from "../../utils/logger.js";
import { retry } from "../../utils/retry.js";
import type {
  Instrument,
  MarketDataProvider,
  ProviderStatus,
  StatusHandler,
  TickHandler,
} from "../types.js";
import {
  loginAngelOne,
  isSessionFresh,
  type AngelCredentials,
  type AngelSession,
} from "./auth.js";
import { AngelOneWebSocket } from "./websocket.js";
import { exchangeName } from "./instruments.js";

export interface AngelOneProviderOptions extends AngelCredentials {
  subscriptionMode: number;
}

export class AngelOneProvider implements MarketDataProvider {
  readonly name = "angelone";
  private session: AngelSession | null = null;
  private ws: AngelOneWebSocket | null = null;
  private tickHandlers: TickHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private status: ProviderStatus = {
    connected: false,
    providerName: this.name,
    ticksReceived: 0,
    reconnectCount: 0,
  };
  private instruments: Instrument[] = [];

  constructor(private opts: AngelOneProviderOptions) {}

  async connect(): Promise<void> {
    logger.info("[angelone] logging in");
    this.session = await loginAngelOne({
      apiKey: this.opts.apiKey,
      clientCode: this.opts.clientCode,
      pin: this.opts.pin,
      totpSecret: this.opts.totpSecret,
    });

    this.ws = new AngelOneWebSocket(
      {
        apiKey: this.opts.apiKey,
        clientCode: this.opts.clientCode,
        feedToken: this.session.feedToken,
        jwtToken: this.session.jwtToken,
        subscriptionMode: this.opts.subscriptionMode,
      },
      {
        onOpen: () => {
          this.status.connected = true;
          this.emitStatus();
        },
        onClose: () => {
          this.status.connected = false;
          if (this.ws) this.status.reconnectCount = this.ws.reconnectCount;
          this.emitStatus();
        },
        onError: (err) => logger.error({ err: err.message }, "[angelone] ws error"),
        onTick: (dt) => {
          const symbol = dt.token;
          const exchange = exchangeName(dt.exchangeType);
          this.status.ticksReceived++;
          this.status.lastTickTs = Date.now();
          this.status.currentContract = symbol;
          for (const h of this.tickHandlers) {
            h({
              provider: this.name,
              symbol,
              instrumentId: `${dt.exchangeType}:${dt.token}`,
              exchange,
              ltp: dt.ltp,
              bid: dt.bestBid,
              ask: dt.bestAsk,
              volume: dt.volume,
              exchangeTs: dt.exchangeTs || undefined,
              receivedTs: Date.now(),
            });
          }
        },
      },
    );

    await this.ws.connect();
  }

  async subscribe(instruments: Instrument[]): Promise<void> {
    this.instruments = instruments;
    if (!this.ws) throw new Error("Provider not connected");
    await this.ws.subscribe(instruments);
  }

  async disconnect(): Promise<void> {
    if (this.ws) await this.ws.disconnect();
    this.status.connected = false;
    this.emitStatus();
  }

  onTick(handler: TickHandler): void {
    this.tickHandlers.push(handler);
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  getStatus(): ProviderStatus {
    return { ...this.status };
  }

  private emitStatus(): void {
    const snapshot = this.getStatus();
    for (const h of this.statusHandlers) h(snapshot);
  }
}

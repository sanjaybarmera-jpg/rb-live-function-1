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
import type { Tick } from "../../models/Tick.js";
import { isStaleTick } from "../../engine/pipeline.js";
import { loadEnv } from "../../config/env.js";

export interface AngelOneProviderOptions extends AngelCredentials {
  subscriptionMode: number;
}

interface TickWaiter {
  resolve: (tick: Tick) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
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
  /** Single-flight guard: concurrent reconnects share one login promise. */
  private authInFlight: Promise<AngelSession> | null = null;
  /** Pending tick-confirmation waiters, keyed by instrument token. */
  private tickWaiters = new Map<string, TickWaiter>();
  /** Last time ANY token produced a valid, non-stale tick. */
  private lastValidTickTs: number | null = null;

  constructor(private opts: AngelOneProviderOptions) {}

  /** True when the tick is usable for confirmation (live, priced). */
  private isValidLiveTick(tick: Tick): boolean {
    if (!(typeof tick.ltp === "number" && isFinite(tick.ltp) && tick.ltp > 0)) return false;
    return !isStaleTick(tick, loadEnv().MAX_TICK_AGE_MS);
  }

  /** Feeds a decoded tick into the confirmation registry. */
  private noteTick(tick: Tick): void {
    if (!this.isValidLiveTick(tick)) return;
    this.lastValidTickTs = Date.now();
    const waiter = this.tickWaiters.get(tick.symbol);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.tickWaiters.delete(tick.symbol);
    waiter.resolve(tick);
  }

  private rejectAllWaiters(reason: string): void {
    for (const [token, waiter] of this.tickWaiters) {
      clearTimeout(waiter.timer);
      this.tickWaiters.delete(token);
      waiter.reject(new Error(reason));
    }
  }

  /** Timestamp of the last valid non-stale tick on any token (market-live hint). */
  getLastValidTickTs(): number | null {
    return this.lastValidTickTs;
  }

  /**
   * Resolves with the first valid, non-stale tick for `token`, or rejects on
   * timeout / websocket disconnect. Timers and waiters are always cleaned up.
   */
  waitForTick(token: string, timeoutMs: number): Promise<Tick> {
    const key = String(token).trim();
    const existing = this.tickWaiters.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.tickWaiters.delete(key);
      existing.reject(new Error("superseded by a newer tick confirmation request"));
    }
    return new Promise<Tick>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.tickWaiters.delete(key);
        reject(new Error("tick confirmation timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.tickWaiters.set(key, { resolve, reject, timer });
    });
  }


  /**
   * Returns a valid session, logging in only when the current one is missing
   * or older than the token max age. Concurrent callers share one attempt.
   */
  private async ensureFreshSession(force = false): Promise<AngelSession> {
    if (!force && isSessionFresh(this.session)) {
      logger.debug(
        { tokenAgeMs: Date.now() - this.session!.issuedAt },
        "[angelone.auth] token still valid — skipping refresh",
      );
      return this.session!;
    }
    if (this.authInFlight) {
      logger.debug("[angelone.auth] refresh already in flight — awaiting it");
      return this.authInFlight;
    }

    logger.info(
      { reason: this.session ? "expired" : "initial" },
      "[angelone.auth] token refresh started",
    );
    this.authInFlight = retry(
      () =>
        loginAngelOne({
          apiKey: this.opts.apiKey,
          clientCode: this.opts.clientCode,
          pin: this.opts.pin,
          totpSecret: this.opts.totpSecret,
        }),
      5,
      { baseMs: 2000, capMs: 60_000 },
    );

    try {
      const session = await this.authInFlight;
      this.session = session;
      logger.info(
        { issuedAt: new Date(session.issuedAt).toISOString() },
        "[angelone.auth] token refresh success",
      );
      return session;
    } catch (err) {
      logger.error({ err }, "[angelone.auth] token refresh failed");
      throw err;
    } finally {
      this.authInFlight = null;
    }
  }

  async connect(): Promise<void> {
    logger.info("[angelone] logging in");
    this.session = await this.ensureFreshSession(true);

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
          // Any pending tick confirmation can never complete on a dead socket.
          this.rejectAllWaiters("websocket disconnected");
          this.emitStatus();
        },
        onError: (err) => logger.error({ err: err.message }, "[angelone] ws error"),
        onNeedAuth: async () => {
          const session = await this.ensureFreshSession();
          return { jwtToken: session.jwtToken, feedToken: session.feedToken };
        },
        onTick: (dt) => {
          const symbol = dt.token;
          const exchange = exchangeName(dt.exchangeType);
          this.status.ticksReceived++;
          this.status.lastTickTs = Date.now();
          this.status.currentContract = symbol;
          const tick: Tick = {
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
          };
          this.noteTick(tick);
          for (const h of this.tickHandlers) h(tick);
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

  /** Active subscription list (source of truth for rollover comparisons). */
  getSubscribed(): Instrument[] {
    return this.ws ? this.ws.getInstruments() : [...this.instruments];
  }

  /** Additive subscribe used by the rollover service. Never disconnects. */
  async subscribeInstruments(add: Instrument[]): Promise<void> {
    if (!this.ws) throw new Error("Provider not connected");
    await this.ws.subscribeInstruments(add);
    this.instruments = this.ws.getInstruments();
  }

  /** Targeted unsubscribe used by the rollover service. Never disconnects. */
  async unsubscribeInstruments(remove: Instrument[]): Promise<void> {
    if (!this.ws) throw new Error("Provider not connected");
    await this.ws.unsubscribeInstruments(remove);
    this.instruments = this.ws.getInstruments();
  }


  async disconnect(): Promise<void> {
    this.rejectAllWaiters("provider disconnected");
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

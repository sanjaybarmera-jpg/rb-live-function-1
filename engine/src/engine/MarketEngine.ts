import { logger } from "../utils/logger.js";
import type { MarketDataProvider, Instrument } from "../providers/types.js";
import type { Tick } from "../models/Tick.js";
import { normalizeTick, stampTick, validateTick } from "./pipeline.js";
import { BoundedQueue } from "./queue.js";
import { CandleAggregator } from "./candles/CandleAggregator.js";
import { parseTimeframes } from "./candles/timeframes.js";
import { RatesWriter } from "../services/RatesWriter.js";
import { RatesHistoryWriter } from "../services/RatesHistoryWriter.js";
import { CandleWriter } from "../services/CandleWriter.js";

export interface MarketEngineOptions {
  provider: MarketDataProvider;
  instruments: Instrument[];
  enabledTimeframes: string;
  historyThrottleMs: number;
}

export class MarketEngine {
  private queue = new BoundedQueue<Tick>(10_000);
  private aggregator: CandleAggregator;
  private rates = new RatesWriter();
  private history: RatesHistoryWriter;
  private candles = new CandleWriter();
  private started = Date.now();
  private tickCounter = 0;
  private tickReportTimer: NodeJS.Timeout | null = null;
  private candleFlushTimer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopping = false;

  constructor(private opts: MarketEngineOptions) {
    this.aggregator = new CandleAggregator(parseTimeframes(opts.enabledTimeframes));
    this.history = new RatesHistoryWriter(opts.historyThrottleMs);

    opts.provider.onTick((t) => this.onTick(t));
    this.aggregator.onCandle(({ candle, closed }) => {
      this.candles.write(candle, closed).catch(() => {
        /* logged in writer */
      });
    });
  }


  async start(): Promise<void> {
    logger.info({ provider: this.opts.provider.name }, "[engine] starting");
    this.rates.start();
    await this.opts.provider.connect();
    await this.opts.provider.subscribe(this.opts.instruments);
    this.tickReportTimer = setInterval(() => {
      logger.info(
        { ticksInLastMinute: this.tickCounter, queueSize: this.queue.size },
        "[engine] tick rate",
      );
      this.tickCounter = 0;
    }, 60_000);
    // Keep the currently-open candles persisted so market_candles is never
    // empty while the market is open (writer throttles duplicate writes).
    this.candleFlushTimer = setInterval(() => this.aggregator.flushOpen(), 5_000);
    this.drain();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickReportTimer) clearInterval(this.tickReportTimer);
    if (this.candleFlushTimer) clearInterval(this.candleFlushTimer);
    await this.opts.provider.disconnect();
    await this.rates.stop();
    logger.info("[engine] stopped");
  }


  private onTick(raw: Tick): void {
    if (!validateTick(raw)) return;
    const tick = stampTick(normalizeTick(raw));
    this.tickCounter++;
    this.queue.push(tick);
    if (!this.draining) this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.size > 0 && !this.stopping) {
        const tick = this.queue.shift();
        if (!tick) break;
        try {
          this.rates.write(tick);
          await this.history.write(tick).catch(() => {});
          this.aggregator.ingest(tick);
        } catch (err) {
          logger.error({ err }, "[engine] pipeline error");
        }
      }
    } finally {
      this.draining = false;
    }
  }

  snapshot() {
    const s = this.opts.provider.getStatus();
    return {
      connected: s.connected,
      providerName: s.providerName,
      currentContract: s.currentContract,
      lastTickTime: s.lastTickTs ? new Date(s.lastTickTs).toISOString() : undefined,
      ticksReceived: s.ticksReceived,
      dbStatus: this.rates.healthy && this.history.healthy && this.candles.healthy,
      reconnectCount: s.reconnectCount,
      engineUptimeSec: Math.floor((Date.now() - this.started) / 1000),
    };
  }
}

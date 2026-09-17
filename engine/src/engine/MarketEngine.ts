import { logger } from "../utils/logger.js";
import type { Tick } from "../models/Tick.js";
import {
  isStaleTick,
  normalizeTick,
  stampTick,
  validateTick,
} from "./pipeline.js";
import { BoundedQueue } from "./queue.js";
import { CandleAggregator } from "./candles/CandleAggregator.js";
import { parseTimeframes } from "./candles/timeframes.js";
import { RatesWriter, type ContractMetadata } from "../services/RatesWriter.js";
import { RatesHistoryWriter } from "../services/RatesHistoryWriter.js";
import { CandleWriter } from "../services/CandleWriter.js";

export interface MarketEngineOptions {
  enabledTimeframes: string;
  historyThrottleMs: number;

  /** Ignore ticks whose source timestamp is older than this (ms). 0 disables. */
  maxTickAgeMs?: number;

  /**
   * Optional contract metadata. The generic HTTP rate API carries no futures
   * contract, so this normally stays empty and price-only writes are used.
   */
  discoveredContracts?: ContractMetadata[];

  /**
   * Allow price-only writes for sources that carry no futures contract
   * (generic HTTP rate API).
   */
  allowMissingContract?: boolean;
}

export class MarketEngine {
  private queue = new BoundedQueue<Tick>(10_000);
  private aggregator: CandleAggregator;
  private rates: RatesWriter;
  private history: RatesHistoryWriter;
  private candles = new CandleWriter();

  private started = Date.now();
  private tickCounter = 0;
  private ticksReceived = 0;
  private tickReportTimer: NodeJS.Timeout | null = null;
  private candleFlushTimer: NodeJS.Timeout | null = null;

  private draining = false;
  private stopping = false;
  private staleTickCount = 0;
  private lastStaleLogAt = 0;
  private lastLiveTickTs = 0;

  private get maxTickAgeMs(): number {
    return this.opts.maxTickAgeMs ?? 120_000;
  }

  constructor(private opts: MarketEngineOptions) {
    this.aggregator = new CandleAggregator(
      parseTimeframes(opts.enabledTimeframes),
    );

    this.history = new RatesHistoryWriter(opts.historyThrottleMs);

    this.rates = new RatesWriter(
      undefined,
      opts.discoveredContracts ?? [],
      undefined,
      opts.allowMissingContract ?? true,
    );

    this.aggregator.onCandle(({ candle, closed }) => {
      this.candles.write(candle, closed).catch(() => {
        /* Error already logged inside CandleWriter */
      });
    });
  }

  /** Update the contract metadata known to RatesWriter (optional). */
  setDiscoveredContracts(contracts: ContractMetadata[]): void {
    this.rates.setDiscoveredContracts(contracts);
  }

  /**
   * Feed a tick produced by the generic HTTP rate API through the existing
   * validation / rate-writing pipeline.
   */
  ingestExternalTick(tick: Tick): void {
    this.onTick(tick);
  }

  async start(): Promise<void> {
    if (this.opts.discoveredContracts && this.opts.discoveredContracts.length > 0) {
      this.rates.setDiscoveredContracts(this.opts.discoveredContracts);
    }

    logger.info({ source: "generic-api" }, "[engine] starting");

    /* Restore today's high/low before receiving live rates. */
    await this.rates.init();
    this.rates.start();

    this.tickReportTimer = setInterval(() => {
      logger.info(
        {
          ticksInLastMinute: this.tickCounter,
          queueSize: this.queue.size,
        },
        "[engine] tick rate",
      );

      this.tickCounter = 0;
    }, 60_000);

    this.candleFlushTimer = setInterval(() => {
      if (
        this.maxTickAgeMs > 0 &&
        Date.now() - this.lastLiveTickTs > this.maxTickAgeMs
      ) {
        return;
      }

      this.aggregator.flushOpen();
    }, 5_000);

    this.drain();
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.tickReportTimer) {
      clearInterval(this.tickReportTimer);
      this.tickReportTimer = null;
    }

    if (this.candleFlushTimer) {
      clearInterval(this.candleFlushTimer);
      this.candleFlushTimer = null;
    }

    await this.rates.stop();

    logger.info("[engine] stopped");
  }

  private onTick(raw: Tick): void {
    if (!validateTick(raw)) {
      return;
    }

    const tick = stampTick(normalizeTick(raw));

    if (isStaleTick(tick, this.maxTickAgeMs)) {
      this.staleTickCount++;
      const now = Date.now();

      if (now - this.lastStaleLogAt > 60_000) {
        this.lastStaleLogAt = now;

        logger.info(
          {
            symbol: tick.symbol,
            staleTickCount: this.staleTickCount,
          },
          "[engine] stale rate ignored — waiting for a fresh API response",
        );
      }

      return;
    }

    this.lastLiveTickTs = Date.now();
    this.tickCounter++;
    this.ticksReceived++;
    this.queue.push(tick);

    if (!this.draining) {
      this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }

    this.draining = true;

    try {
      while (this.queue.size > 0 && !this.stopping) {
        const tick = this.queue.shift();
        if (!tick) break;

        try {
          this.rates.write(tick);

          /* History is never on the critical rate path. */
          void this.history.write(tick).catch(() => {
            /* Error already logged by writer */
          });

          this.aggregator.ingest(tick);
        } catch (err) {
          logger.error(
            {
              err,
              symbol: tick.symbol,
              instrumentId: tick.instrumentId,
              ltp: tick.ltp,
            },
            "[engine] pipeline error",
          );
        }
      }
    } finally {
      this.draining = false;
    }
  }

  snapshot() {
    return {
      connected:
        this.lastLiveTickTs > 0 &&
        (this.maxTickAgeMs <= 0 ||
          Date.now() - this.lastLiveTickTs <= this.maxTickAgeMs),
      providerName: "generic-api",
      lastTickTime: this.lastLiveTickTs
        ? new Date(this.lastLiveTickTs).toISOString()
        : undefined,
      ticksReceived: this.ticksReceived,
      dbStatus:
        this.rates.healthy && this.history.healthy && this.candles.healthy,
      reconnectCount: 0,
      engineUptimeSec: Math.floor((Date.now() - this.started) / 1000),
      staleTicksIgnored: this.staleTickCount,
      lastLiveTickTime: this.lastLiveTickTs
        ? new Date(this.lastLiveTickTs).toISOString()
        : undefined,
      marketLive:
        this.maxTickAgeMs <= 0 ||
        (this.lastLiveTickTs > 0 &&
          Date.now() - this.lastLiveTickTs <= this.maxTickAgeMs),
    };
  }
}

import { logger } from "../utils/logger.js";
import type { MarketDataProvider, Instrument } from "../providers/types.js";
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
import { RatesWriter } from "../services/RatesWriter.js";
import { RatesHistoryWriter } from "../services/RatesHistoryWriter.js";
import { CandleWriter } from "../services/CandleWriter.js";

export interface MarketEngineOptions {
  provider: MarketDataProvider;
  instruments: Instrument[];
  enabledTimeframes: string;
  historyThrottleMs: number;

  /** Ignore ticks whose exchange timestamp is older than this (ms). 0 disables. */
  maxTickAgeMs?: number;
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

    this.history = new RatesHistoryWriter(
      opts.historyThrottleMs,
    );

    /*
     * Every Angel One tick comes through this single pipeline.
     *
     * RatesWriter is responsible for:
     *   - mcx_ltp
     *   - high
     *   - low
     *   - contract_symbol
     *   - contract_month
     *   - expiry_date
     *
     * Therefore MarketEngine must NOT hardcode any contract information.
     */
    opts.provider.onTick((tick) => {
      this.onTick(tick);
    });

    this.aggregator.onCandle(({ candle, closed }) => {
      this.candles
        .write(candle, closed)
        .catch(() => {
          /* Error already logged inside CandleWriter */
        });
    });
  }

  async start(): Promise<void> {
    logger.info(
      {
        provider: this.opts.provider.name,
      },
      "[engine] starting",
    );

    /*
     * Restore today's high/low and existing contract metadata
     * before receiving live ticks.
     */
    await this.rates.init();

    this.rates.start();

    /*
     * Connect Angel One websocket.
     */
    await this.opts.provider.connect();

    /*
     * Subscribe to instruments selected by discovery.
     *
     * In AUTO mode these are the contracts returned by ScripMaster,
     * e.g.:
     *
     * GOLD05OCT26FUT
     * SILVER04SEP26FUT
     *
     * No contract is hardcoded here.
     */
    await this.opts.provider.subscribe(
      this.opts.instruments,
    );

    /*
     * Tick-rate monitoring.
     */
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

    /*
     * Keep currently-open candles persisted while live ticks
     * are still arriving.
     */
    this.candleFlushTimer = setInterval(() => {
      if (
        this.maxTickAgeMs > 0 &&
        Date.now() - this.lastLiveTickTs > this.maxTickAgeMs
      ) {
        return;
      }

      this.aggregator.flushOpen();
    }, 5_000);

    /*
     * Start processing the tick queue.
     */
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

    /*
     * Disconnect websocket first.
     */
    await this.opts.provider.disconnect();

    /*
     * Flush remaining rate data, including contract metadata.
     */
    await this.rates.stop();

    logger.info("[engine] stopped");
  }

  private onTick(raw: Tick): void {
    /*
     * First validate the provider tick.
     */
    if (!validateTick(raw)) {
      return;
    }

    /*
     * Normalize the provider-specific tick into our common Tick model.
     */
    const tick = stampTick(
      normalizeTick(raw),
    );

    /*
     * Ignore stale/replayed ticks.
     *
     * This is important after market close because Angel One can
     * resend the previous contract's last traded price.
     */
    if (
      isStaleTick(
        tick,
        this.maxTickAgeMs,
      )
    ) {
      this.staleTickCount++;

      const now = Date.now();

      if (
        now - this.lastStaleLogAt >
        60_000
      ) {
        this.lastStaleLogAt = now;

        logger.info(
          {
            symbol: tick.symbol,
            exchangeTs: tick.exchangeTs,
            ageSec: tick.exchangeTs
              ? Math.floor(
                  (now - tick.exchangeTs) / 1000,
                )
              : undefined,
            maxTickAgeMs: this.maxTickAgeMs,
            staleTickCount: this.staleTickCount,
          },
          "[engine] stale tick ignored (market likely closed) — waiting for live tick",
        );
      }

      return;
    }

    /*
     * We have a genuinely live tick.
     */
    this.lastLiveTickTs = Date.now();

    this.tickCounter++;

    /*
     * Put tick into bounded processing queue.
     */
    this.queue.push(tick);

    /*
     * Start drain immediately if it is not already running.
     */
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
      while (
        this.queue.size > 0 &&
        !this.stopping
      ) {
        const tick = this.queue.shift();

        if (!tick) {
          break;
        }

        try {
          /*
           * IMPORTANT:
           *
           * RatesWriter receives the ORIGINAL normalized tick.
           *
           * RatesWriter determines:
           *   GOLD/SILVER group
           *   current contract symbol
           *   contract month
           *   expiry date
           *
           * from the live tick / discovered contract mapping.
           */
          this.rates.write(tick);

          /*
           * Historical rate storage.
           */
          await this.history
            .write(tick)
            .catch(() => {
              /* Error already logged by writer */
            });

          /*
           * Candle aggregation.
           */
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
    const status =
      this.opts.provider.getStatus();

    return {
      connected: status.connected,

      providerName:
        status.providerName,

      currentContract:
        status.currentContract,

      lastTickTime:
        status.lastTickTs
          ? new Date(
              status.lastTickTs,
            ).toISOString()
          : undefined,

      ticksReceived:
        status.ticksReceived,

      dbStatus:
        this.rates.healthy &&
        this.history.healthy &&
        this.candles.healthy,

      reconnectCount:
        status.reconnectCount,

      engineUptimeSec:
        Math.floor(
          (Date.now() - this.started) /
            1000,
        ),

      staleTicksIgnored:
        this.staleTickCount,

      lastLiveTickTime:
        this.lastLiveTickTs
          ? new Date(
              this.lastLiveTickTs,
            ).toISOString()
          : undefined,

      marketLive:
        this.maxTickAgeMs <= 0 ||
        (
          this.lastLiveTickTs > 0 &&
          Date.now() -
            this.lastLiveTickTs <=
            this.maxTickAgeMs
        ),
    };
  }
}

import { logger } from "../utils/logger.js";
import { fetchJson, type HttpClientConfig } from "../providers/genericapi/httpClient.js";
import { parseRates } from "../providers/genericapi/parser.js";
import {
  INSTRUMENT_KEYS,
  type InstrumentKey,
  type MetalQuote,
  type NormalizedRates,
  type ParserConfig,
} from "../providers/genericapi/types.js";
import type { Tick } from "../models/Tick.js";

/**
 * GenericRateService
 *
 * Polls ANY configured HTTP rate API, validates and normalizes the response,
 * and hands the resulting Gold/Silver prices to the existing RB rate logic.
 *
 * No provider name, URL or response shape lives in this file — everything is
 * supplied by configuration.
 */

export type PriceField = "bid" | "ask" | "mid";

export interface GenericRateServiceOptions {
  http: HttpClientConfig;
  parser: ParserConfig;
  intervalMs: number;
  /** Reject responses whose provider timestamp is older than this (0 = off). */
  maxAgeMs: number;
  /** Retained for backward compatibility; LTP now comes from PRICE_PATH. */
  priceField: PriceField;
  /** Sink into the existing RB pipeline (gold/silver MCX). */
  onRates: (tick: Tick) => void;
  /**
   * Sink for the non-MCX spot sources (usd_inr, usd_gold, usd_silver).
   * The key is the RB internal rates id, never the provider id.
   */
  onSpot?: (
    key: Exclude<InstrumentKey, "gold" | "silver">,
    quote: MetalQuote,
    fetchedAt: string,
  ) => void;
}

export interface MetalApiDiagnostics {
  configured: boolean;
  configuredId: string | null;
  configuredSymbol: string | null;
  matchedBy: string | null;
  matchedId: string | null;
  matchedSymbol: string | null;
  lastValue: number | null;
  lastUpdate: string | null;
  high: number | null;
  low: number | null;
  error: string | null;
}

export interface GenericApiDiagnostics {
  configured: boolean;
  url?: string;
  method?: string;
  authType?: string;
  intervalMs?: number;
  requests?: number;
  successes?: number;
  failures?: number;
  rejected?: number;
  lastSuccess?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  lastUpdate?: string | null;
  gold?: MetalApiDiagnostics;
  silver?: MetalApiDiagnostics;
  instruments?: Partial<Record<InstrumentKey, MetalApiDiagnostics>>;
}

function priceOf(quote: MetalQuote, field: PriceField): number {
  if (field === "ask") return quote.ask ?? quote.ltp;
  if (field === "mid") return quote.ask ? (quote.ltp + quote.ask) / 2 : quote.ltp;
  return quote.ltp;
}

export class GenericRateService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private requests = 0;
  private successes = 0;
  private failures = 0;
  private rejected = 0;
  private lastSuccess: string | null = null;
  private lastError: string | null = null;
  private lastErrorAt: string | null = null;
  private latest: NormalizedRates | null = null;

  constructor(private opts: GenericRateServiceOptions) {}

  get snapshot(): NormalizedRates | null {
    return this.latest;
  }

  private instrumentDiagnostics(key: InstrumentKey): MetalApiDiagnostics {
    const mapping = this.opts.parser[key];
    const q = this.latest?.instruments[key];

    return {
      configured: Boolean(mapping && Object.keys(mapping).length),
      configuredId: mapping?.id ?? null,
      configuredSymbol: mapping?.symbol ?? null,
      matchedBy: q?.matchedBy ?? null,
      matchedId: q?.matchedId ?? null,
      matchedSymbol: q?.matchedSymbol ?? null,
      lastValue: q ? q.ltp : null,
      lastUpdate: this.latest?.fetchedAt ?? null,
      high: q?.high ?? null,
      low: q?.low ?? null,
      error: this.latest?.errors[key] ?? null,
    };
  }

  diagnostics(): GenericApiDiagnostics {
    const instruments: Partial<Record<InstrumentKey, MetalApiDiagnostics>> = {};
    for (const key of INSTRUMENT_KEYS) {
      instruments[key] = this.instrumentDiagnostics(key);
    }

    return {
      configured: true,
      url: this.opts.http.url,
      method: this.opts.http.method,
      authType: this.opts.http.authType,
      intervalMs: this.opts.intervalMs,
      requests: this.requests,
      successes: this.successes,
      failures: this.failures,
      rejected: this.rejected,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      lastUpdate: this.latest?.fetchedAt ?? null,
      gold: instruments.gold!,
      silver: instruments.silver!,
      instruments,
    };
  }

  start(): void {
    this.stopped = false;

    logger.info(
      {
        method: this.opts.http.method,
        authType: this.opts.http.authType,
        intervalMs: this.opts.intervalMs,
        priceField: this.opts.priceField,
      },
      "[API] generic rate source starting",
    );

    void this.poll();

    this.timer = setInterval(() => {
      void this.poll();
    }, this.opts.intervalMs);

    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle. NEVER throws — an API outage must not crash the engine. */
  async poll(): Promise<NormalizedRates | null> {
    if (this.stopped) return null;

    this.requests++;

    logger.debug("[API] Request started");

    let body: unknown;

    try {
      body = await fetchJson(this.opts.http);
      logger.debug("[API] Response received");
    } catch (err) {
      this.failures++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastErrorAt = new Date().toISOString();
      // API key is never logged.
      logger.error({ err: this.lastError }, "[API] Request failed");
      return null;
    }

    let rates: NormalizedRates;

    try {
      rates = parseRates(body, this.opts.parser);
    } catch (err) {
      this.rejected++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastErrorAt = new Date().toISOString();
      logger.error({ err: this.lastError }, "[API] Response parsing failed");
      return null;
    }

    // Staleness — only enforced when the provider exposes a timestamp.
    if (this.opts.maxAgeMs > 0 && rates.timestamp) {
      const ageMs = Date.now() - Date.parse(rates.timestamp);
      if (Number.isFinite(ageMs) && ageMs > this.opts.maxAgeMs) {
        this.rejected++;
        this.lastError = `stale response (${Math.round(ageMs / 1000)}s old)`;
        this.lastErrorAt = new Date().toISOString();
        logger.warn(
          { ageMs, timestamp: rates.timestamp },
          "[API] stale response rejected — previous rate kept",
        );
        return null;
      }
    }

    this.latest = rates;
    this.successes++;
    this.lastSuccess = rates.fetchedAt;
    this.lastError = null;

    const mappingErrors = Object.entries(rates.errors);
    if (mappingErrors.length > 0) {
      logger.warn(
        { mappingErrors: Object.fromEntries(mappingErrors) },
        "[API] instrument mapping failed for one or more configured sources",
      );
    }

    const goldPrice = priceOf(rates.gold, this.opts.priceField);
    const silverPrice = priceOf(rates.silver, this.opts.priceField);

    logger.info({ gold: goldPrice }, `[API] Gold parsed: ${goldPrice}`);
    logger.info({ silver: silverPrice }, `[API] Silver parsed: ${silverPrice}`);

    const receivedTs = Date.parse(rates.fetchedAt);

    this.emit("gold", goldPrice, rates, receivedTs);
    this.emit("silver", silverPrice, rates, receivedTs);

    /*
     * Non-MCX spot sources. They bypass the MCX session/contract logic and
     * are written straight to their existing RB rows (usd_* ids).
     */
    for (const key of ["usd_inr", "usd_gold", "usd_silver"] as const) {
      const quote = rates.instruments[key];
      if (!quote) continue;

      try {
        this.opts.onSpot?.(key, quote, rates.fetchedAt);
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), key },
          "[RATES] spot source update failed",
        );
      }
    }

    return rates;
  }

  private emit(
    group: "gold" | "silver",
    price: number,
    rates: NormalizedRates,
    receivedTs: number,
  ): void {
    const quote = rates[group];

    const tick: Tick = {
      provider: "generic-api",
      symbol: group,
      instrumentId: group,
      exchange: "API",
      ltp: price,
      ...(quote.bid ? { bid: quote.bid } : {}),
      ...(quote.ask ? { ask: quote.ask } : {}),
      receivedTs,
    };

    try {
      this.opts.onRates(tick);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), group },
        "[RATES] Supabase update failed",
      );
    }
  }
}

let active: GenericRateService | null = null;

export function setGenericRateService(svc: GenericRateService | null): void {
  active = svc;
}

export function getGenericApiDiagnostics(): GenericApiDiagnostics {
  return active ? active.diagnostics() : { configured: false };
}

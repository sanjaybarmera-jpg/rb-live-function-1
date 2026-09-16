import axios from "axios";
import { logger } from "../utils/logger.js";

/**
 * MetalpriceAPI — SECONDARY, spot-only data source.
 *
 * This service is completely independent of the Angel One MCX futures feed.
 * It never writes to the `rates` table, never touches contract metadata and
 * can fail indefinitely without affecting the primary pipeline.
 */

const TROY_OUNCE_GRAMS = 31.1034768;

export interface SpotSnapshot {
  /** Gold spot, USD per troy ounce. */
  goldUsdPerOz: number;
  /** Silver spot, USD per troy ounce. */
  silverUsdPerOz: number;
  /** USD -> INR conversion rate. */
  usdInr: number;
  /** Derived INR per gram (spot, no premium / duty / making). */
  goldInrPerGram: number;
  silverInrPerGram: number;
  /** Provider timestamp (ISO) as reported by MetalpriceAPI. */
  providerTimestamp: string | null;
  /** When this engine received the response. */
  fetchedAt: string;
}

export interface MetalPriceDiagnostics {
  enabled: boolean;
  pollIntervalMs: number;
  requests: number;
  successes: number;
  failures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  latest: SpotSnapshot | null;
  /** Per-row write diagnostics for usd_gold / usd_silver / usd_inr. */
  rows?: unknown;
}

/** Sink that persists a spot snapshot (SpotRatesWriter in production). */
export interface SpotSnapshotSink {
  write(snapshot: SpotSnapshot): Promise<void>;
  snapshot?(): unknown;
}

export interface MetalPriceServiceOptions {
  apiKey: string;
  /** Polling interval in ms. */
  intervalMs: number;
  /** Request timeout in ms. */
  timeoutMs: number;
  baseUrl?: string;
  /** Optional writer for the three existing usd_* rows in `rates`. */
  writer?: SpotSnapshotSink;
}

interface MetalPriceResponse {
  success?: boolean;
  timestamp?: number;
  base?: string;
  rates?: Record<string, number>;
  error?: { code?: number | string; message?: string; info?: string };
}

/**
 * MetalpriceAPI returns USD -> X rates, e.g. rates.XAU = ounces per 1 USD.
 * USD per ounce is therefore 1 / rates.XAU. The API also exposes the inverted
 * convenience keys (USDXAU). Both shapes are handled.
 */
function usdPerOunce(rates: Record<string, number>, symbol: string): number | null {
  const direct = rates[symbol];
  if (typeof direct === "number" && direct > 0) {
    return 1 / direct;
  }

  const inverted = rates[`USD${symbol}`];
  if (typeof inverted === "number" && inverted > 0) {
    return 1 / inverted;
  }

  return null;
}

function inrRate(rates: Record<string, number>): number | null {
  const direct = rates["INR"] ?? rates["USDINR"];
  return typeof direct === "number" && direct > 0 ? direct : null;
}

export function toInrPerGram(usdPerOz: number, usdInr: number): number {
  return (usdPerOz * usdInr) / TROY_OUNCE_GRAMS;
}

export class MetalPriceService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private requests = 0;
  private successes = 0;
  private failures = 0;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastError: string | null = null;
  private latest: SpotSnapshot | null = null;

  constructor(private opts: MetalPriceServiceOptions) {}

  get snapshot(): SpotSnapshot | null {
    return this.latest;
  }

  diagnostics(): MetalPriceDiagnostics {
    return {
      enabled: true,
      pollIntervalMs: this.opts.intervalMs,
      requests: this.requests,
      successes: this.successes,
      failures: this.failures,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastError: this.lastError,
      latest: this.latest,
      rows: this.opts.writer?.snapshot?.() ?? null,
    };
  }

  start(): void {
    this.stopped = false;

    logger.info(
      { intervalMs: this.opts.intervalMs },
      "[metalprice] secondary spot source starting",
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

  /**
   * One fetch cycle. NEVER throws — a MetalpriceAPI outage must not disturb
   * the Angel One pipeline in any way.
   */
  async poll(): Promise<SpotSnapshot | null> {
    if (this.stopped) return null;

    this.requests++;

    const base = this.opts.baseUrl ?? "https://api.metalpriceapi.com/v1";

    try {
      const res = await axios.get<MetalPriceResponse>(`${base}/latest`, {
        timeout: this.opts.timeoutMs,
        params: {
          api_key: this.opts.apiKey,
          base: "USD",
          currencies: "XAU,XAG,INR",
        },
        headers: { Accept: "application/json" },
      });

      const data = res.data;

      if (!data || data.success === false || !data.rates) {
        throw new Error(
          data?.error?.message ??
            data?.error?.info ??
            "MetalpriceAPI returned an unsuccessful response",
        );
      }

      const goldUsdPerOz = usdPerOunce(data.rates, "XAU");
      const silverUsdPerOz = usdPerOunce(data.rates, "XAG");
      const usdInr = inrRate(data.rates);

      if (goldUsdPerOz === null || silverUsdPerOz === null || usdInr === null) {
        throw new Error("MetalpriceAPI response missing XAU / XAG / INR rates");
      }

      const snapshot: SpotSnapshot = {
        goldUsdPerOz,
        silverUsdPerOz,
        usdInr,
        goldInrPerGram: toInrPerGram(goldUsdPerOz, usdInr),
        silverInrPerGram: toInrPerGram(silverUsdPerOz, usdInr),
        providerTimestamp:
          typeof data.timestamp === "number"
            ? new Date(data.timestamp * 1000).toISOString()
            : null,
        fetchedAt: new Date().toISOString(),
      };

      this.latest = snapshot;
      this.successes++;
      this.lastSuccessAt = snapshot.fetchedAt;
      this.lastError = null;

      // API key is never logged.
      logger.info(
        {
          xauUsdPerOz: Number(goldUsdPerOz.toFixed(2)),
          xagUsdPerOz: Number(silverUsdPerOz.toFixed(4)),
          usdInr: Number(usdInr.toFixed(4)),
          goldInrPerGram: Number(snapshot.goldInrPerGram.toFixed(2)),
          silverInrPerGram: Number(snapshot.silverInrPerGram.toFixed(2)),
          providerTimestamp: snapshot.providerTimestamp,
          fetchedAt: snapshot.fetchedAt,
        },
        "[metalprice] spot snapshot updated",
      );

      /*
       * Persist into the three EXISTING rates rows (usd_gold / usd_silver /
       * usd_inr). Never throws — MCX writes must stay unaffected.
       */
      if (this.opts.writer) {
        try {
          await this.opts.writer.write(snapshot);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "[metalprice] usd_* row write failed — MCX feed unaffected",
          );
        }
      }

      return snapshot;
    } catch (err) {
      this.failures++;
      this.lastFailureAt = new Date().toISOString();
      this.lastError = err instanceof Error ? err.message : String(err);

      logger.warn(
        {
          err: this.lastError,
          failures: this.failures,
          lastSuccessAt: this.lastSuccessAt,
        },
        "[metalprice] fetch failed — Angel One / MCX feed is unaffected",
      );

      return null;
    }
  }
}

let active: MetalPriceService | null = null;

export function setMetalPriceService(svc: MetalPriceService | null): void {
  active = svc;
}

export function getMetalPriceDiagnostics(): MetalPriceDiagnostics | { enabled: false } {
  return active ? active.diagnostics() : { enabled: false };
}

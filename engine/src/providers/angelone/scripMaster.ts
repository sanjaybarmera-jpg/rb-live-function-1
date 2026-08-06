import axios from "axios";
import { logger } from "../../utils/logger.js";

const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

/** Lightweight projection of a scrip-master row (full rows are never retained). */
export interface ScripInstrument {
  token: string;
  symbol: string;
  name: string;
  /** Raw expiry string as published by Angel One, e.g. "05AUG2026". */
  expiry: string;
  exchange: string;
  lotSize: number;
}

interface RawScrip {
  token?: string;
  symbol?: string;
  name?: string;
  expiry?: string;
  exch_seg?: string;
  instrumenttype?: string;
  lotsize?: string | number;
}

interface CacheEntry {
  fetchedAt: number;
  instruments: ScripInstrument[];
}

let cache: CacheEntry | null = null;

export interface ScripMasterOptions {
  /** Cache time-to-live in ms. */
  ttlMs?: number;
  /** Force a network refresh regardless of cache age. */
  force?: boolean;
  /** HTTP timeout in ms. */
  timeoutMs?: number;
}

/** Age of the in-memory cache in ms, or null when nothing is cached. */
export function scripMasterCacheAgeMs(): number | null {
  return cache ? Date.now() - cache.fetchedAt : null;
}

function isMcxFuture(row: RawScrip): boolean {
  const exch = (row.exch_seg ?? "").toUpperCase();
  if (exch !== "MCX") return false;
  const type = (row.instrumenttype ?? "").toUpperCase();
  // FUTCOM = commodity futures; FUTBLN/FUTIDX also appear for bullion-ish series.
  return type.startsWith("FUT");
}

function project(row: RawScrip): ScripInstrument | null {
  if (!row.token || !row.symbol) return null;
  return {
    token: String(row.token),
    symbol: String(row.symbol).toUpperCase(),
    name: String(row.name ?? "").toUpperCase(),
    expiry: String(row.expiry ?? "").toUpperCase(),
    exchange: (row.exch_seg ?? "MCX").toUpperCase(),
    lotSize: Number(row.lotsize ?? 0) || 0,
  };
}

/**
 * Fetch (or reuse) the MCX futures slice of the Angel One scrip master.
 *
 * The upstream file is ~25MB; the parsed array is filtered down immediately and
 * only the projected rows are kept, so the large structure becomes garbage as
 * soon as this function returns. Failures fall back to the last good cache and
 * otherwise throw — callers must treat this as a soft dependency.
 */
export async function loadMcxFutures(
  opts: ScripMasterOptions = {},
): Promise<ScripInstrument[]> {
  const ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  if (!opts.force && cache && Date.now() - cache.fetchedAt < ttlMs) {
    logger.info(
      { count: cache.instruments.length, ageMs: Date.now() - cache.fetchedAt },
      "[scripmaster] using cached ScripMaster",
    );
    return cache.instruments;
  }

  logger.info({ url: SCRIP_MASTER_URL }, "[scripmaster] ScripMaster download started");
  try {
    const started = Date.now();
    const { data } = await axios.get<RawScrip[]>(SCRIP_MASTER_URL, {
      timeout: timeoutMs,
      responseType: "json",
      maxContentLength: 200 * 1024 * 1024,
      maxBodyLength: 200 * 1024 * 1024,
    });

    if (!Array.isArray(data)) throw new Error("ScripMaster payload is not an array");

    const instruments: ScripInstrument[] = [];
    for (const row of data) {
      if (!isMcxFuture(row)) continue;
      const p = project(row);
      if (p) instruments.push(p);
    }

    cache = { fetchedAt: Date.now(), instruments };
    logger.info(
      { total: data.length, mcxFutures: instruments.length, ms: Date.now() - started },
      "[scripmaster] ScripMaster download completed",
    );
    return instruments;
  } catch (err) {
    if (cache) {
      logger.warn(
        { err, ageMs: Date.now() - cache.fetchedAt },
        "[scripmaster] download failed — using last cached ScripMaster",
      );
      return cache.instruments;
    }
    logger.error({ err }, "[scripmaster] download failed and no cache available");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Test/ops helper — drops the in-memory cache. */
export function clearScripMasterCache(): void {
  cache = null;
}

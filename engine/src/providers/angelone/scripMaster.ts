import axios from "axios";
import { logger } from "../../utils/logger.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIP_MASTER_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// engine/.cache/OpenAPIScripMaster.json
const CACHE_DIR = path.resolve(__dirname, "../../../.cache");
const CACHE_FILE = path.join(CACHE_DIR, "OpenAPIScripMaster.json");

export interface ScripInstrument {
  token: string;
  symbol: string;
  name: string;
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
  ttlMs?: number;
  force?: boolean;
  timeoutMs?: number;
}

export function scripMasterCacheAgeMs(): number | null {
  return cache ? Date.now() - cache.fetchedAt : null;
}

function isMcxFuture(row: RawScrip): boolean {
  const exch = (row.exch_seg ?? "").toUpperCase();
  if (exch !== "MCX") return false;

  const type = (row.instrumenttype ?? "").toUpperCase();

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

async function loadDiskCache(): Promise<CacheEntry | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as CacheEntry;

    if (
      !parsed ||
      !Number.isFinite(parsed.fetchedAt) ||
      !Array.isArray(parsed.instruments)
    ) {
      return null;
    }

    logger.info(
      {
        count: parsed.instruments.length,
        ageMs: Date.now() - parsed.fetchedAt,
      },
      "[scripmaster] persistent cache loaded",
    );

    return parsed;
  } catch {
    return null;
  }
}

async function saveDiskCache(entry: CacheEntry): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const tmpFile = `${CACHE_FILE}.tmp`;

  await fs.writeFile(
    tmpFile,
    JSON.stringify(entry),
    "utf8",
  );

  await fs.rename(tmpFile, CACHE_FILE);
}

async function downloadScripMaster(
  timeoutMs: number,
): Promise<RawScrip[]> {
  const started = Date.now();

  /*
   * IMPORTANT:
   * Do NOT use responseType:"json" here.
   *
   * Angel One's ScripMaster is a very large JSON file.
   * Streaming the response avoids Axios aborting while parsing
   * the complete JSON payload.
   */
  const response = await axios.get<unknown>(SCRIP_MASTER_URL, {
    timeout: Math.max(timeoutMs, 180_000),
    responseType: "text",
    maxContentLength: 200 * 1024 * 1024,
    maxBodyLength: 200 * 1024 * 1024,
    decompress: true,
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      Connection: "keep-alive",
    },
  });

  if (typeof response.data !== "string") {
    throw new Error("ScripMaster response was not text");
  }

  const raw = JSON.parse(response.data);

  if (!Array.isArray(raw)) {
    throw new Error("ScripMaster payload is not an array");
  }

  logger.info(
    {
      total: raw.length,
      bytes: response.data.length,
      ms: Date.now() - started,
    },
    "[scripmaster] raw download parsed",
  );

  return raw as RawScrip[];
}

export async function loadMcxFutures(
  opts: ScripMasterOptions = {},
): Promise<ScripInstrument[]> {
  const ttlMs = opts.ttlMs ?? 6 * 60 * 60 * 1000;
  const timeoutMs = opts.timeoutMs ?? 180_000;

  // 1. In-memory cache
  if (
    !opts.force &&
    cache &&
    Date.now() - cache.fetchedAt < ttlMs
  ) {
    logger.info(
      {
        count: cache.instruments.length,
        ageMs: Date.now() - cache.fetchedAt,
      },
      "[scripmaster] using in-memory cache",
    );

    return cache.instruments;
  }

  // 2. Persistent disk cache
  if (!opts.force && !cache) {
    const diskCache = await loadDiskCache();

    if (diskCache) {
      cache = diskCache;

      if (Date.now() - diskCache.fetchedAt < ttlMs) {
        return diskCache.instruments;
      }

      logger.info(
        {
          ageMs: Date.now() - diskCache.fetchedAt,
        },
        "[scripmaster] disk cache expired — refreshing",
      );
    }
  }

  logger.info(
    {
      url: SCRIP_MASTER_URL,
      timeoutMs,
    },
    "[scripmaster] ScripMaster download started",
  );

  try {
    const rawRows = await downloadScripMaster(timeoutMs);

    const instruments: ScripInstrument[] = [];

    for (const row of rawRows) {
      if (!isMcxFuture(row)) continue;

      const projected = project(row);

      if (projected) {
        instruments.push(projected);
      }
    }

    if (instruments.length === 0) {
      throw new Error(
        "ScripMaster download succeeded but no MCX futures were found",
      );
    }

    const entry: CacheEntry = {
      fetchedAt: Date.now(),
      instruments,
    };

    cache = entry;

    await saveDiskCache(entry);

    logger.info(
      {
        total: rawRows.length,
        mcxFutures: instruments.length,
        cacheFile: CACHE_FILE,
      },
      "[scripmaster] ScripMaster cache updated",
    );

    return instruments;
  } catch (err) {
    /*
     * NEVER lose a previously discovered contract just because
     * Angel One's ScripMaster endpoint temporarily fails.
     */

    if (!cache) {
      cache = await loadDiskCache();
    }

    if (cache) {
      logger.warn(
        {
          err,
          ageMs: Date.now() - cache.fetchedAt,
        },
        "[scripmaster] download failed — using cached ScripMaster",
      );

      return cache.instruments;
    }

    logger.error(
      { err },
      "[scripmaster] download failed and no cache available",
    );

    throw err instanceof Error
      ? err
      : new Error(String(err));
  }
}

export function clearScripMasterCache(): void {
  cache = null;
}

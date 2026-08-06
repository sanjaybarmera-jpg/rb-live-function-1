import { loadEnv, parseInstruments } from "../../config/env.js";
import type { Instrument } from "../types.js";
import { logger } from "../../utils/logger.js";
import { setTokenGroup, type MetalGroup } from "../../services/metals.js";
import { loadMcxFutures, scripMasterCacheAgeMs, type ScripInstrument } from "./scripMaster.js";

/** Load the configured instrument subscription list from env. */
export function loadConfiguredInstruments(): Instrument[] {
  const env = loadEnv();
  const parsed = parseInstruments(env.ANGEL_INSTRUMENTS);
  return parsed.map((p) => ({ exchangeType: p.exchangeType, token: p.token }));
}

const EXCHANGE_NAMES: Record<number, string> = {
  1: "NSE_CM",
  2: "NSE_FO",
  3: "BSE_CM",
  4: "BSE_FO",
  5: "MCX_FO",
  7: "NCX_FO",
  13: "CDE_FO",
};

export function exchangeName(exchangeType: number): string {
  return EXCHANGE_NAMES[exchangeType] ?? `EXCH_${exchangeType}`;
}

const MCX_EXCHANGE_TYPE = 5;
const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Parse Angel One expiry strings like "05AUG2026" into epoch ms (UTC). */
export function parseExpiry(raw: string): number | null {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(raw.trim().toUpperCase());
  if (!m) return null;
  const month = MONTHS[m[2]!];
  if (month === undefined) return null;
  // Expiry counts through the end of the expiry day.
  return Date.UTC(Number(m[3]), month, Number(m[1]), 23, 59, 59);
}

export interface DiscoveredContract {
  group: MetalGroup;
  token: string;
  symbol: string;
  name: string;
  expiry: string;
  expiryMs: number;
  lotSize: number;
}

export interface DiscoveryResult {
  instruments: Instrument[];
  contracts: DiscoveredContract[];
  /** ScripMaster cache age at selection time, in ms. */
  cacheAgeMs: number | null;
  discoveredAt: string;
}

/**
 * Pick the nearest non-expired contract for a metal, honouring the rollover
 * buffer (contracts expiring within `bufferDays` are skipped).
 *
 * Prefix matching is exact-name based so GOLD does not match GOLDM/GOLDPETAL.
 */
function selectNearest(
  rows: ScripInstrument[],
  prefix: string,
  bufferMs: number,
  now: number,
): { row: ScripInstrument; expiryMs: number } | null {
  const target = prefix.trim().toUpperCase();
  const candidates = rows
    .filter((r) => r.name === target || r.symbol.startsWith(target))
    .map((r) => ({ row: r, expiryMs: parseExpiry(r.expiry) ?? -1 }))
    .filter((c) => c.expiryMs > 0 && c.expiryMs - bufferMs > now)
    // Exact name matches win over loose symbol-prefix matches.
    .sort((a, b) => {
      const aExact = a.row.name === target ? 0 : 1;
      const bExact = b.row.name === target ? 0 : 1;
      return aExact - bExact || a.expiryMs - b.expiryMs;
    });
  return candidates[0] ?? null;
}

/**
 * Discover the active MCX Gold and Silver futures from the Angel One scrip
 * master and register their tokens with the metal-group map.
 *
 * Throws when neither metal can be resolved; callers fall back to env config.
 */
export async function discoverInstruments(): Promise<DiscoveryResult> {
  const env = loadEnv();
  const rows = await loadMcxFutures({ ttlMs: env.SCRIPMASTER_CACHE_TTL });

  const now = Date.now();
  const bufferMs = env.ROLLOVER_DAYS_BEFORE_EXPIRY * 24 * 60 * 60 * 1000;

  const wanted: Array<{ group: MetalGroup; prefix: string }> = [
    { group: "gold", prefix: env.MCX_GOLD_SYMBOL_PREFIX },
    { group: "silver", prefix: env.MCX_SILVER_SYMBOL_PREFIX },
  ];

  const contracts: DiscoveredContract[] = [];
  for (const { group, prefix } of wanted) {
    const hit = selectNearest(rows, prefix, bufferMs, now);
    if (!hit) {
      logger.warn({ group, prefix }, "[discovery] no active contract found");
      continue;
    }
    const contract: DiscoveredContract = {
      group,
      token: hit.row.token,
      symbol: hit.row.symbol,
      name: hit.row.name,
      expiry: hit.row.expiry,
      expiryMs: hit.expiryMs,
      lotSize: hit.row.lotSize,
    };
    contracts.push(contract);
    setTokenGroup(contract.token, group);
    logger.info(
      {
        token: contract.token,
        symbol: contract.symbol,
        expiry: contract.expiry,
        lotSize: contract.lotSize,
      },
      `[discovery] selected ${group === "gold" ? "Gold" : "Silver"} contract`,
    );
  }

  if (contracts.length === 0) {
    throw new Error("ScripMaster discovery found no active MCX Gold/Silver contracts");
  }

  return {
    instruments: contracts.map((c) => ({
      exchangeType: MCX_EXCHANGE_TYPE,
      token: c.token,
    })),
    contracts,
    cacheAgeMs: scripMasterCacheAgeMs(),
    discoveredAt: new Date().toISOString(),
  };
}

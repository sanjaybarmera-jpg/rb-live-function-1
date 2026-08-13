import { loadEnv, parseInstruments } from "../../config/env.js";
import type { Instrument } from "../types.js";
import { logger } from "../../utils/logger.js";
import {
  setTokenGroup,
  type MetalGroup,
} from "../../services/metals.js";
import {
  loadMcxFutures,
  scripMasterCacheAgeMs,
  type ScripInstrument,
} from "./scripMaster.js";

export function loadConfiguredInstruments(): Instrument[] {
  const env = loadEnv();
  const parsed = parseInstruments(env.ANGEL_INSTRUMENTS);

  return parsed.map((p) => ({
    exchangeType: p.exchangeType,
    token: p.token,
  }));
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
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

export function parseExpiry(raw: string): number | null {
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(
    raw.trim().toUpperCase(),
  );

  if (!m) return null;

  const month = MONTHS[m[2]!];

  if (month === undefined) return null;

  return Date.UTC(
    Number(m[3]),
    month,
    Number(m[1]),
    23,
    59,
    59,
    999,
  );
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
  cacheAgeMs: number | null;
  discoveredAt: string;
}

/**
 * Select the nearest valid STANDARD MCX contract.
 *
 * GOLD:
 *   GOLD05OCT26FUT       ✅
 *   GOLDM04SEP26FUT      ❌
 *   GOLDPETAL...         ❌
 *   GOLDGUINEA...        ❌
 *   GOLDTEN...           ❌
 *
 * SILVER:
 *   SILVER04SEP26FUT     ✅
 *   SILVERM...            ❌
 */
function selectNearest(
  rows: ScripInstrument[],
  name: string,
  bufferMs: number,
  now: number,
): { row: ScripInstrument; expiryMs: number } | null {
  const target = name.trim().toUpperCase();

  const candidates = rows
    .filter((row) => {
      return (
        row.exchange === "MCX" &&
        row.name.trim().toUpperCase() === target
      );
    })
    .map((row) => ({
      row,
      expiryMs: parseExpiry(row.expiry) ?? -1,
    }))
    .filter((candidate) => {
      return (
        candidate.expiryMs > 0 &&
        candidate.expiryMs - bufferMs > now
      );
    })
    .sort((a, b) => a.expiryMs - b.expiryMs);

  return candidates[0] ?? null;
}

export async function discoverInstruments(): Promise<DiscoveryResult> {
  const env = loadEnv();

  const rows = await loadMcxFutures({
    ttlMs: env.SCRIPMASTER_CACHE_TTL,
  });

  const now = Date.now();

  const bufferMs =
    env.ROLLOVER_DAYS_BEFORE_EXPIRY *
    24 *
    60 *
    60 *
    1000;

  const wanted: Array<{
    group: MetalGroup;
    name: string;
  }> = [
    {
      group: "gold",
      name: env.MCX_GOLD_SYMBOL_PREFIX,
    },
    {
      group: "silver",
      name: env.MCX_SILVER_SYMBOL_PREFIX,
    },
  ];

  const contracts: DiscoveredContract[] = [];

  for (const { group, name } of wanted) {
    const hit = selectNearest(
      rows,
      name,
      bufferMs,
      now,
    );

    if (!hit) {
      logger.warn(
        {
          group,
          name,
          rolloverDays: env.ROLLOVER_DAYS_BEFORE_EXPIRY,
        },
        "[discovery] no active standard MCX contract found",
      );

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
        group,
        token: contract.token,
        symbol: contract.symbol,
        name: contract.name,
        expiry: contract.expiry,
        lotSize: contract.lotSize,
      },
      `[discovery] selected ${
        group === "gold" ? "Gold" : "Silver"
      } contract`,
    );
  }

  if (contracts.length === 0) {
    throw new Error(
      "ScripMaster discovery found no active standard MCX Gold/Silver contracts",
    );
  }

  return {
    instruments: contracts.map((contract) => ({
      exchangeType: MCX_EXCHANGE_TYPE,
      token: contract.token,
    })),

    contracts,

    cacheAgeMs: scripMasterCacheAgeMs(),

    discoveredAt: new Date().toISOString(),
  };
}

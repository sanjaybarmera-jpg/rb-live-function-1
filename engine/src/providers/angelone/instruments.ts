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

/** Default exchange for MCX bullion futures when an entry omits it. */
const DEFAULT_EXCHANGE_TYPE = 5;

export interface EnvFallbackResult {
  instruments: Instrument[];
  mappings: Record<string, MetalGroup>;
  goldToken: string | null;
  silverToken: string | null;
  issues: string[];
}

function normalizeToken(raw: string): string {
  return raw.trim();
}

/**
 * Build the ENV fallback subscription list from ANGEL_INSTRUMENTS and
 * METAL_TOKEN_MAP. Pure (no env / no logging) so it can be unit tested.
 *
 * Accepted ANGEL_INSTRUMENTS entry formats:
 *   "5:466583"   EXCHANGE:TOKEN
 *   "466583"     bare numeric token (defaults to MCX)
 * Accepted METAL_TOKEN_MAP entry format:
 *   "466583:gold,471725:silver"
 *
 * Tokens present ONLY in METAL_TOKEN_MAP are still subscribed — a valid metal
 * mapping is sufficient to resolve an instrument.
 */
export function buildEnvFallback(
  rawInstruments: string,
  rawTokenMap: string,
): EnvFallbackResult {
  const issues: string[] = [];
  const mappings: Record<string, MetalGroup> = {};

  // 1. METAL_TOKEN_MAP -> token => group
  for (const entry of (rawTokenMap ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(":").map((p) => p.trim());
    const token = normalizeToken(parts[0] ?? "");
    const group = (parts[1] ?? "").toLowerCase();

    if (!token || (group !== "gold" && group !== "silver")) {
      issues.push(`METAL_TOKEN_MAP entry "${trimmed}" is malformed — ignored`);
      continue;
    }

    mappings[token] = group;
  }

  // 2. ANGEL_INSTRUMENTS -> exchange/token pairs
  const ordered: Instrument[] = [];
  const seen = new Set<string>();

  const push = (exchangeType: number, token: string): void => {
    const key = `${exchangeType}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push({ exchangeType, token });
  };

  for (const entry of (rawInstruments ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(":").map((p) => p.trim());

    let exchangeType = DEFAULT_EXCHANGE_TYPE;
    let token: string;

    if (parts.length === 1) {
      token = normalizeToken(parts[0] ?? "");
    } else {
      const exch = Number(parts[0]);
      if (!Number.isInteger(exch) || exch <= 0) {
        issues.push(
          `ANGEL_INSTRUMENTS entry "${trimmed}" has an invalid exchange code — ignored`,
        );
        continue;
      }
      exchangeType = exch;
      token = normalizeToken(parts[1] ?? "");
    }

    if (!token) {
      issues.push(`ANGEL_INSTRUMENTS entry "${trimmed}" has no token — ignored`);
      continue;
    }

    push(exchangeType, token);
  }

  // 3. Tokens known only through METAL_TOKEN_MAP are still valid instruments.
  for (const token of Object.keys(mappings)) {
    push(DEFAULT_EXCHANGE_TYPE, token);
  }

  const goldToken =
    Object.keys(mappings).find((t) => mappings[t] === "gold") ?? null;
  const silverToken =
    Object.keys(mappings).find((t) => mappings[t] === "silver") ?? null;

  return { instruments: ordered, mappings, goldToken, silverToken, issues };
}

/**
 * ENV fallback used when ScripMaster discovery is unavailable.
 * Registers metal mappings and logs non-secret startup diagnostics.
 */
export function loadConfiguredInstruments(): Instrument[] {
  const env = loadEnv();

  const result = buildEnvFallback(
    env.ANGEL_INSTRUMENTS,
    process.env["METAL_TOKEN_MAP"] ?? "",
  );

  for (const [token, group] of Object.entries(result.mappings)) {
    setTokenGroup(token, group);
  }

  for (const issue of result.issues) {
    logger.warn({ issue }, "[env-fallback] malformed configuration entry");
  }

  logger.info(
    {
      angelInstrumentsConfigured: Boolean(env.ANGEL_INSTRUMENTS.trim()),
      metalTokenMapConfigured: Boolean(
        (process.env["METAL_TOKEN_MAP"] ?? "").trim(),
      ),
      parsedInstrumentCount: result.instruments.length,
      goldResolved: Boolean(result.goldToken),
      silverResolved: Boolean(result.silverToken),
      mappingFailures: result.issues.length,
    },
    "[env-fallback] instruments resolved from environment",
  );

  if (result.instruments.length === 0) {
    logger.error(
      "[env-fallback] no instruments could be resolved — set ANGEL_INSTRUMENTS or METAL_TOKEN_MAP",
    );
  }

  return result.instruments;
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

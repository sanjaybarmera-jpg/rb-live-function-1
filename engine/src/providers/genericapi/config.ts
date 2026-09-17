import type { Env } from "../../config/env.js";
import type { HttpClientConfig } from "./httpClient.js";
import type { MetalMapping, ParserConfig } from "./types.js";

/** Safely parse a JSON object from an env string; {} on anything invalid. */
export function parseJsonRecord(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = String(v);
      }
      return out;
    }
  } catch {
    /* ignore — configuration error is reported by the caller's diagnostics */
  }
  return {};
}

export function isGenericApiConfigured(env: Env): boolean {
  return Boolean(env.RATE_API_URL.trim());
}

export function buildHttpConfig(env: Env): HttpClientConfig {
  let body: unknown = undefined;
  if (env.RATE_API_BODY.trim()) {
    try {
      body = JSON.parse(env.RATE_API_BODY);
    } catch {
      body = {};
    }
  }

  return {
    url: env.RATE_API_URL.trim(),
    method: env.RATE_API_METHOD,
    apiKey: env.RATE_API_KEY.trim(),
    authType: env.RATE_API_AUTH_TYPE,
    keyName: env.RATE_API_KEY_NAME.trim() || "api_key",
    timeoutMs: env.RATE_API_TIMEOUT_MS,
    headers: parseJsonRecord(env.RATE_API_HEADERS),
    query: parseJsonRecord(env.RATE_API_QUERY),
    ...(body !== undefined ? { body } : {}),
  };
}

function opt(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v ? v : undefined;
}

/** Build one instrument mapping from its ENV prefix (GOLD, USD_INR, ...). */
export function buildInstrumentMapping(
  env: Record<string, unknown>,
  prefix: string,
): MetalMapping {
  const get = (suffix: string): string | undefined =>
    opt(env[`${prefix}_${suffix}`] as string | undefined);

  const mapping: MetalMapping = {};
  const id = get("ID");
  const symbol = get("SYMBOL");
  const price = get("PRICE_PATH");
  const high = get("HIGH_PATH");
  const low = get("LOW_PATH");
  const bid = get("BID_PATH");
  const ask = get("ASK_PATH");

  if (id) mapping.id = id;
  if (symbol) mapping.symbol = symbol;
  if (price) mapping.pricePath = price;
  if (high) mapping.highPath = high;
  if (low) mapping.lowPath = low;
  if (bid) mapping.bidPath = bid;
  if (ask) mapping.askPath = ask;

  return mapping;
}

export function buildParserConfig(env: Env): ParserConfig {
  const raw = env as unknown as Record<string, unknown>;

  const cfg: ParserConfig = {
    ...(opt(env.RATE_API_ITEMS_PATH) ? { itemsPath: env.RATE_API_ITEMS_PATH.trim() } : {}),
    ...(opt(env.RATE_API_ID_FIELD) ? { idField: env.RATE_API_ID_FIELD.trim() } : {}),
    symbolField: env.RATE_API_SYMBOL_FIELD.trim() || "symbol",
    ...(opt(env.RATE_API_TIMESTAMP_PATH)
      ? { timestampPath: env.RATE_API_TIMESTAMP_PATH.trim() }
      : {}),
    gold: buildInstrumentMapping(raw, "GOLD"),
    silver: buildInstrumentMapping(raw, "SILVER"),
  };

  const usdInr = buildInstrumentMapping(raw, "USD_INR");
  const usdGold = buildInstrumentMapping(raw, "USD_GOLD");
  const usdSilver = buildInstrumentMapping(raw, "USD_SILVER");

  if (Object.keys(usdInr).length) cfg.usd_inr = usdInr;
  if (Object.keys(usdGold).length) cfg.usd_gold = usdGold;
  if (Object.keys(usdSilver).length) cfg.usd_silver = usdSilver;

  return cfg;
}

import type { Env } from "../../config/env.js";
import type { HttpClientConfig } from "./httpClient.js";
import type { ParserConfig } from "./types.js";

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

function opt(value: string): string | undefined {
  const v = value.trim();
  return v ? v : undefined;
}

export function buildParserConfig(env: Env): ParserConfig {
  return {
    ...(opt(env.RATE_API_ITEMS_PATH) ? { itemsPath: env.RATE_API_ITEMS_PATH.trim() } : {}),
    symbolField: env.RATE_API_SYMBOL_FIELD.trim() || "symbol",
    ...(opt(env.RATE_API_TIMESTAMP_PATH)
      ? { timestampPath: env.RATE_API_TIMESTAMP_PATH.trim() }
      : {}),
    gold: {
      ...(opt(env.GOLD_SYMBOL) ? { symbol: env.GOLD_SYMBOL.trim() } : {}),
      ...(opt(env.GOLD_BID_PATH) ? { bidPath: env.GOLD_BID_PATH.trim() } : {}),
      ...(opt(env.GOLD_ASK_PATH) ? { askPath: env.GOLD_ASK_PATH.trim() } : {}),
      ...(opt(env.GOLD_HIGH_PATH) ? { highPath: env.GOLD_HIGH_PATH.trim() } : {}),
      ...(opt(env.GOLD_LOW_PATH) ? { lowPath: env.GOLD_LOW_PATH.trim() } : {}),
      ...(opt(env.GOLD_PRICE_PATH) ? { pricePath: env.GOLD_PRICE_PATH.trim() } : {}),
    },
    silver: {
      ...(opt(env.SILVER_SYMBOL) ? { symbol: env.SILVER_SYMBOL.trim() } : {}),
      ...(opt(env.SILVER_BID_PATH) ? { bidPath: env.SILVER_BID_PATH.trim() } : {}),
      ...(opt(env.SILVER_ASK_PATH) ? { askPath: env.SILVER_ASK_PATH.trim() } : {}),
      ...(opt(env.SILVER_HIGH_PATH) ? { highPath: env.SILVER_HIGH_PATH.trim() } : {}),
      ...(opt(env.SILVER_LOW_PATH) ? { lowPath: env.SILVER_LOW_PATH.trim() } : {}),
      ...(opt(env.SILVER_PRICE_PATH) ? { pricePath: env.SILVER_PRICE_PATH.trim() } : {}),
    },
  };
}

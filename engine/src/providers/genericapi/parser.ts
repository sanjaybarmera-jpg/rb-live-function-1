import { collectObjectArrays, resolvePath, toNumber } from "./path.js";
import {
  INSTRUMENT_KEYS,
  type InstrumentKey,
  type MetalMapping,
  type MetalQuote,
  type NormalizedRates,
  type ParserConfig,
} from "./types.js";

/**
 * Generic, configuration-driven response parser.
 *
 * No provider name, URL or response shape is hardcoded. Any JSON response can
 * be mapped using id lookup (primary), symbol lookup (fallback) and/or field
 * paths supplied by configuration.
 */

export class ParseError extends Error {}

function candidateLists(root: unknown, cfg: ParserConfig): unknown[][] {
  if (cfg.itemsPath) {
    const items = resolvePath(root, cfg.itemsPath);
    return Array.isArray(items) ? [items] : [];
  }
  return collectObjectArrays(root);
}

function fieldString(item: unknown, field: string | undefined): string | null {
  if (!field || !item || typeof item !== "object") return null;
  const raw = (item as Record<string, unknown>)[field];
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number") return String(raw);
  return null;
}

function eq(a: string | null, b: string | undefined): boolean {
  if (a === null || b === undefined) return false;
  return a.toLowerCase() === b.trim().toLowerCase();
}

function findByField(
  root: unknown,
  cfg: ParserConfig,
  field: string | undefined,
  wanted: string,
): unknown | undefined {
  if (!field) return undefined;
  for (const list of candidateLists(root, cfg)) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (eq(fieldString(item, field), wanted)) return item;
    }
  }
  return undefined;
}

function readNumber(
  base: unknown,
  root: unknown,
  path: string | undefined,
): number | null {
  if (!path) return null;

  // Relative to the matched item first, then absolute against the root.
  const local = base === root ? undefined : resolvePath(base, path);
  const value = local !== undefined ? local : resolvePath(root, path);
  return toNumber(value);
}

/**
 * Resolve one configured instrument. Throws ParseError with a clear reason so
 * mapping failures surface in diagnostics instead of being silently ignored.
 */
export function parseInstrument(
  root: unknown,
  cfg: ParserConfig,
  mapping: MetalMapping,
  label: string,
): MetalQuote {
  let base: unknown = root;
  let matchedBy: MetalQuote["matchedBy"] = "path";

  if (mapping.id) {
    if (!cfg.idField) {
      throw new ParseError(`${label}: id configured but RATE_API_ID_FIELD is not set`);
    }

    const match = findByField(root, cfg, cfg.idField, mapping.id);
    if (match === undefined) {
      throw new ParseError(`${label}: id "${mapping.id}" not found`);
    }

    // Never silently accept a wrong instrument when both are configured.
    if (mapping.symbol) {
      const sym = fieldString(match, cfg.symbolField);
      if (!eq(sym, mapping.symbol)) {
        throw new ParseError(
          `${label}: id/symbol mismatch — id "${mapping.id}" resolved to symbol "${sym ?? "unknown"}", expected "${mapping.symbol}"`,
        );
      }
    }

    base = match;
    matchedBy = "id";
  } else if (mapping.symbol) {
    const match = findByField(root, cfg, cfg.symbolField, mapping.symbol);
    if (match === undefined) {
      if (!mapping.pricePath && !mapping.bidPath) {
        throw new ParseError(`${label}: symbol "${mapping.symbol}" not found`);
      }
    } else {
      base = match;
      matchedBy = "symbol";
    }
  }

  // LTP comes from the configured price path; bid/ask remain back-compat only.
  // When an instrument matched by id/symbol but no explicit path resolved a
  // value, fall back to the shared/default price fields (bid, then ask).
  const ltp =
    readNumber(base, root, mapping.pricePath) ??
    readNumber(base, root, mapping.bidPath) ??
    readNumber(base, root, mapping.askPath) ??
    (matchedBy !== "path"
      ? readNumber(base, root, "bid") ?? readNumber(base, root, "ask")
      : null);

  if (ltp === null) {
    throw new ParseError(`${label}: no numeric price found`);
  }

  if (ltp <= 0) {
    throw new ParseError(`${label}: price must be greater than zero`);
  }

  // Explicit high/low paths win; matched items fall back to the shared
  // default field names "high"/"low".
  const defaultHilo = matchedBy !== "path";
  const high = readNumber(base, root, mapping.highPath ?? (defaultHilo ? "high" : undefined));
  const low = readNumber(base, root, mapping.lowPath ?? (defaultHilo ? "low" : undefined));
  const ask = readNumber(base, root, mapping.askPath ?? (defaultHilo ? "ask" : undefined));

  return {
    ltp,
    high: high !== null && high > 0 ? high : null,
    low: low !== null && low > 0 ? low : null,
    bid: ltp,
    ask: ask !== null && ask > 0 ? ask : null,
    matchedBy,
    matchedId: fieldString(base, cfg.idField),
    matchedSymbol: fieldString(base, cfg.symbolField),
  };
}

function isConfigured(mapping: MetalMapping | undefined): mapping is MetalMapping {
  if (!mapping) return false;
  return Boolean(
    mapping.id || mapping.symbol || mapping.pricePath || mapping.bidPath,
  );
}

function parseTimestamp(root: unknown, path?: string): string | null {
  if (!path) return null;

  const raw = resolvePath(root, path);

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }

  if (typeof raw === "string" && raw.trim()) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  return null;
}

export function parseRates(root: unknown, cfg: ParserConfig): NormalizedRates {
  if (root === null || typeof root !== "object") {
    throw new ParseError("response body is not a JSON object");
  }

  const instruments: NormalizedRates["instruments"] = {};
  const errors: NormalizedRates["errors"] = {};

  for (const key of INSTRUMENT_KEYS) {
    const mapping = cfg[key] as MetalMapping | undefined;
    if (!isConfigured(mapping)) continue;

    try {
      instruments[key] = parseInstrument(root, cfg, mapping, key);
    } catch (err) {
      errors[key] = err instanceof Error ? err.message : String(err);
    }
  }

  // Gold and Silver remain the required RB pipeline sources.
  for (const key of ["gold", "silver"] as InstrumentKey[]) {
    if (!instruments[key]) {
      throw new ParseError(errors[key] ?? `${key}: not configured`);
    }
  }

  return {
    gold: instruments.gold!,
    silver: instruments.silver!,
    instruments,
    errors,
    timestamp: parseTimestamp(root, cfg.timestampPath),
    fetchedAt: new Date().toISOString(),
  };
}

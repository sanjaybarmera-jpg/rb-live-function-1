import { collectObjectArrays, resolvePath, toNumber } from "./path.js";
import type {
  MetalMapping,
  MetalQuote,
  NormalizedRates,
  ParserConfig,
} from "./types.js";

/**
 * Generic, configuration-driven response parser.
 *
 * No provider name, URL or response shape is hardcoded. Any JSON response can
 * be mapped using symbol lookup and/or field paths supplied by configuration.
 */

export class ParseError extends Error {}

function findBySymbol(
  root: unknown,
  cfg: ParserConfig,
  symbol: string,
): unknown | undefined {
  const wanted = symbol.trim().toLowerCase();

  const candidates: unknown[][] = [];

  if (cfg.itemsPath) {
    const items = resolvePath(root, cfg.itemsPath);
    if (Array.isArray(items)) candidates.push(items);
  } else {
    candidates.push(...collectObjectArrays(root));
  }

  for (const list of candidates) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const raw = (item as Record<string, unknown>)[cfg.symbolField];
      if (typeof raw !== "string") continue;
      if (raw.trim().toLowerCase() === wanted) return item;
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

function parseMetal(
  root: unknown,
  cfg: ParserConfig,
  mapping: MetalMapping,
  label: string,
): MetalQuote {
  let base: unknown = root;

  if (mapping.symbol) {
    const match = findBySymbol(root, cfg, mapping.symbol);
    if (match === undefined && !mapping.bidPath && !mapping.pricePath) {
      throw new ParseError(`${label}: symbol "${mapping.symbol}" not found`);
    }
    if (match !== undefined) base = match;
  }

  const bid =
    readNumber(base, root, mapping.bidPath) ??
    readNumber(base, root, mapping.pricePath);

  if (bid === null) {
    throw new ParseError(`${label}: no numeric price found`);
  }

  if (bid <= 0) {
    throw new ParseError(`${label}: price must be greater than zero`);
  }

  const ask = readNumber(base, root, mapping.askPath);
  const high = readNumber(base, root, mapping.highPath);
  const low = readNumber(base, root, mapping.lowPath);

  return {
    bid,
    ask: ask !== null && ask > 0 ? ask : null,
    high: high !== null && high > 0 ? high : null,
    low: low !== null && low > 0 ? low : null,
  };
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

  return {
    gold: parseMetal(root, cfg, cfg.gold, "gold"),
    silver: parseMetal(root, cfg, cfg.silver, "silver"),
    timestamp: parseTimestamp(root, cfg.timestampPath),
    fetchedAt: new Date().toISOString(),
  };
}

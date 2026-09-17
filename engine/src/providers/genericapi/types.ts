/** Provider-agnostic types for the generic HTTP rate source. */

export type AuthType = "none" | "query" | "header" | "bearer";
export type HttpMethod = "GET" | "POST";

/** The five configurable live-rate sources. */
export type InstrumentKey =
  | "gold"
  | "silver"
  | "usd_inr"
  | "usd_gold"
  | "usd_silver";

export const INSTRUMENT_KEYS: InstrumentKey[] = [
  "gold",
  "silver",
  "usd_inr",
  "usd_gold",
  "usd_silver",
];

export interface MetalMapping {
  /** Provider instrument id, matched against ParserConfig.idField. Primary. */
  id?: string;
  /** Symbol/name used by the provider, e.g. "India Gold". Fallback. */
  symbol?: string;
  /** LTP path (preferred). */
  pricePath?: string;
  highPath?: string;
  lowPath?: string;
  /** Legacy/back-compat only — never required by the 5-source parser. */
  bidPath?: string;
  askPath?: string;
}

export interface ParserConfig {
  /** Path to the array of quotes, e.g. "data". Optional — auto-detected. */
  itemsPath?: string;
  /** Field inside an array item holding the provider id, e.g. "id". */
  idField?: string;
  /** Field inside an array item holding the symbol, e.g. "symbol". */
  symbolField: string;
  /** Path to a response timestamp, if the provider exposes one. */
  timestampPath?: string;
  gold: MetalMapping;
  silver: MetalMapping;
  usd_inr?: MetalMapping;
  usd_gold?: MetalMapping;
  usd_silver?: MetalMapping;
}

export interface MetalQuote {
  /** Last traded price. */
  ltp: number;
  high: number | null;
  low: number | null;
  /** Back-compat: the same value as ltp, kept for existing consumers. */
  bid: number;
  ask: number | null;
  /** Which criterion actually matched the provider item. */
  matchedBy?: "id" | "symbol" | "path";
  matchedId?: string | null;
  matchedSymbol?: string | null;
}

export interface NormalizedRates {
  gold: MetalQuote;
  silver: MetalQuote;
  /** All configured instruments, including the USD sources when mapped. */
  instruments: Partial<Record<InstrumentKey, MetalQuote>>;
  /** Per-instrument mapping/parsing errors (empty when everything mapped). */
  errors: Partial<Record<InstrumentKey, string>>;
  /** ISO timestamp reported by the provider, when available. */
  timestamp: string | null;
  /** ISO timestamp of the successful fetch. */
  fetchedAt: string;
}

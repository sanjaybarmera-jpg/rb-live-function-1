/** Provider-agnostic types for the generic HTTP rate source. */

export type AuthType = "none" | "query" | "header" | "bearer";
export type HttpMethod = "GET" | "POST";

export interface MetalMapping {
  /** Symbol/name used by the provider, e.g. "India Gold". Optional. */
  symbol?: string;
  bidPath?: string;
  askPath?: string;
  highPath?: string;
  lowPath?: string;
  /** Single-price responses (e.g. result.gold.price). */
  pricePath?: string;
}

export interface ParserConfig {
  /** Path to the array of quotes, e.g. "data". Optional — auto-detected. */
  itemsPath?: string;
  /** Field inside an array item holding the symbol, e.g. "symbol". */
  symbolField: string;
  /** Path to a response timestamp, if the provider exposes one. */
  timestampPath?: string;
  gold: MetalMapping;
  silver: MetalMapping;
}

export interface MetalQuote {
  bid: number;
  ask: number | null;
  high: number | null;
  low: number | null;
}

export interface NormalizedRates {
  gold: MetalQuote;
  silver: MetalQuote;
  /** ISO timestamp reported by the provider, when available. */
  timestamp: string | null;
  /** ISO timestamp of the successful fetch. */
  fetchedAt: string;
}

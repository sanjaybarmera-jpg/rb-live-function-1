/** Maps provider symbols/tokens onto the Ratan Bullion metal_type groups. */

export type MetalGroup = "gold" | "silver";

export const GOLD_METAL_TYPES = [
  "gold",
  "gold_999",
  "gold_9930",
  "gold_999_rtgs",
  "gold_9930_rtgs",
] as const;

export const SILVER_METAL_TYPES = [
  "silver",
  "silver_999",
  "silver_98",
  "silver_999_rtgs",
  "silver_98_rtgs",
] as const;

/**
 * Angel One streams numeric instrument tokens, not readable contract names,
 * so a token -> metal group map is required. Configure via METAL_TOKEN_MAP
 * (e.g. "466583:gold,471725:silver"). Auto-discovered contracts register
 * themselves at runtime via setTokenGroup(), which overrides the env seed.
 */
function loadTokenMap(): Map<string, MetalGroup> {
  const raw = process.env["METAL_TOKEN_MAP"] ?? "";
  const map = new Map<string, MetalGroup>();
  for (const entry of raw.split(",")) {
    const [token, group] = entry.trim().split(":");
    if (!token || !group) continue;
    const g = group.trim().toLowerCase();
    if (g === "gold" || g === "silver") map.set(token.trim(), g);
  }
  return map;
}

let tokenMap: Map<string, MetalGroup> | null = null;
/** Runtime registrations take precedence over the env seed. */
const runtimeMap = new Map<string, MetalGroup>();

function ensureSeed(): Map<string, MetalGroup> {
  if (!tokenMap) tokenMap = loadTokenMap();
  return tokenMap;
}

/** Register (or override) a token -> metal group mapping at runtime. */
export function setTokenGroup(token: string, group: MetalGroup): void {
  runtimeMap.set(String(token).trim(), group);
}

/** Current effective mapping (env seed merged with runtime overrides). */
export function getTokenGroups(): Record<string, MetalGroup> {
  const merged: Record<string, MetalGroup> = {};
  for (const [k, v] of ensureSeed()) merged[k] = v;
  for (const [k, v] of runtimeMap) merged[k] = v;
  return merged;
}

export function metalGroupForSymbol(symbol: string): MetalGroup | null {
  const key = symbol.trim();
  const runtime = runtimeMap.get(key);
  if (runtime) return runtime;

  const direct = ensureSeed().get(key);
  if (direct) return direct;

  const s = symbol.toUpperCase();
  if (s.includes("GOLD")) return "gold";
  if (s.includes("SILVER")) return "silver";
  return null;
}

export function metalTypesForGroup(group: MetalGroup): readonly string[] {
  return group === "gold" ? GOLD_METAL_TYPES : SILVER_METAL_TYPES;
}

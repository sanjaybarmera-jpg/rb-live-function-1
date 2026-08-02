/** Maps provider symbols onto the Ratan Bullion metal_type groups. */

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

export function metalGroupForSymbol(symbol: string): MetalGroup | null {
  const s = symbol.toUpperCase();
  if (s.includes("GOLD")) return "gold";
  if (s.includes("SILVER")) return "silver";
  return null;
}

export function metalTypesForGroup(group: MetalGroup): readonly string[] {
  return group === "gold" ? GOLD_METAL_TYPES : SILVER_METAL_TYPES;
}

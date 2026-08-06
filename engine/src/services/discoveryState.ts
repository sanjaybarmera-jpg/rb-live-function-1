/** Read-only discovery state surfaced by the health endpoint. */

export interface DiscoveryInfo {
  mode: "env" | "auto";
  /** Where the active instrument list actually came from. */
  source: "env" | "scripmaster" | "env-fallback";
  timestamp: string;
  goldToken?: string;
  silverToken?: string;
  cacheAgeMs?: number | null;
  error?: string;
}

let state: DiscoveryInfo = {
  mode: "env",
  source: "env",
  timestamp: new Date().toISOString(),
};

export function setDiscoveryState(next: DiscoveryInfo): void {
  state = next;
}

export function getDiscoveryState(): DiscoveryInfo {
  return { ...state };
}

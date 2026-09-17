/**
 * Tiny, dependency-free path resolver used by the generic response parser.
 *
 * Supported syntax (provider agnostic):
 *   "bid"
 *   "data.gold.bid"
 *   "data[3].bid"
 *   "result.items[0].price"
 */

export function resolvePath(root: unknown, path: string): unknown {
  const clean = path.trim();
  if (!clean) return undefined;

  const parts = clean
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);

  let current: unknown = root;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current !== "object") return undefined;

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/** Parse "151,156.50" / 151156 / " 151156 " into a finite number, else null. */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const cleaned = value.replace(/[,\s]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

/**
 * Collect candidate arrays of objects from a response, so symbol-based lookup
 * works even when the caller did not configure an explicit items path.
 */
export function collectObjectArrays(root: unknown, maxDepth = 3): unknown[][] {
  const found: unknown[][] = [];

  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== "object") return;

    if (Array.isArray(node)) {
      if (node.some((i) => i && typeof i === "object")) found.push(node);
      return;
    }

    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value, depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

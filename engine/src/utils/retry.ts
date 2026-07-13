export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  factor?: number;
}

export function nextBackoff(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1000, capMs = 30_000, factor = 2 } = opts;
  const raw = Math.min(capMs, baseMs * Math.pow(factor, attempt));
  const jitter = Math.random() * 0.3 * raw;
  return Math.floor(raw + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 5,
  opts: BackoffOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      await sleep(nextBackoff(i, opts));
    }
  }
  throw lastErr;
}

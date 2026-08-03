/**
 * MCX trading-session helpers.
 *
 * MCX runs a single continuous session per trading day, roughly
 * 09:00 -> 23:30/23:55 IST. Because the session never crosses IST midnight,
 * the IST calendar date is a safe, stable session identifier.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** IST calendar date (YYYY-MM-DD) for a UTC epoch timestamp. */
export function sessionKeyFor(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Current session key based on wall-clock time. */
export function currentSessionKey(now: number = Date.now()): string {
  return sessionKeyFor(now);
}

/** True when both timestamps belong to the same MCX trading session. */
export function isSameSession(a: number, b: number): boolean {
  return sessionKeyFor(a) === sessionKeyFor(b);
}

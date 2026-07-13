export function nowMs(): number {
  return Date.now();
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Floor a timestamp (ms) to the start of its bucket (bucket size in ms). */
export function bucketStart(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

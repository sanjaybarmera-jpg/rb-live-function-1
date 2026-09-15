/**
 * Lightweight per-metal feed diagnostics.
 *
 * Pure in-memory counters, exposed read-only through /health.
 * No secrets, no PII, no behaviour changes.
 */
import type { MetalGroup } from "./metals.js";

export interface MetalFeedDiagnostics {
  mappedToken: string | null;
  ticksReceived: number;
  lastTickTime: string | null;
  lastLtp: number | null;

  /** Ticks whose LTP differed from the previously stored value. */
  ltpChanged: number;
  /** Ticks whose LTP was identical to the stored value (no write needed). */
  duplicateLtp: number;
  lastLtpChangedAt: string | null;

  writeAttempts: number;
  writesStarted: number;
  writesSucceeded: number;
  writesFailed: number;
  /** True when a newer tick is waiting behind an in-flight write. */
  pendingLatestTick: boolean;

  lastWriteAttempt: string | null;
  lastSuccessfulWrite: string | null;
  lastDbWriteAt: string | null;
  lastAffectedRows: number | null;
  /** Supabase round-trip duration of the last successful write (ms). */
  lastWriteLatencyMs: number | null;
  /** Angel tick received -> DB write start, for the last successful write (ms). */
  lastTickToWriteMs: number | null;

  writeFailures: number;
  zeroRowUpdates: number;
  lastWriteError: string | null;
}

function empty(): MetalFeedDiagnostics {
  return {
    mappedToken: null,
    ticksReceived: 0,
    lastTickTime: null,
    lastLtp: null,
    ltpChanged: 0,
    duplicateLtp: 0,
    lastLtpChangedAt: null,
    writeAttempts: 0,
    writesStarted: 0,
    writesSucceeded: 0,
    writesFailed: 0,
    pendingLatestTick: false,
    lastWriteAttempt: null,
    lastSuccessfulWrite: null,
    lastDbWriteAt: null,
    lastAffectedRows: null,
    lastWriteLatencyMs: null,
    lastTickToWriteMs: null,
    writeFailures: 0,
    zeroRowUpdates: 0,
    lastWriteError: null,
  };
}

const metals: Record<MetalGroup, MetalFeedDiagnostics> = {
  gold: empty(),
  silver: empty(),
};

let mappingFailures = 0;
const unmappedSymbols = new Set<string>();

export function recordTick(
  group: MetalGroup,
  token: string,
  ltp: number,
  ts: string,
): void {
  const d = metals[group];
  d.mappedToken = token;
  d.ticksReceived += 1;
  d.lastTickTime = ts;
  d.lastLtp = ltp;
}

/** Records whether a tick carried a genuinely new LTP. */
export function recordLtpObservation(group: MetalGroup, changed: boolean): void {
  const d = metals[group];
  if (changed) {
    d.ltpChanged += 1;
    d.lastLtpChangedAt = new Date().toISOString();
  } else {
    d.duplicateLtp += 1;
  }
}

/** True while a newer tick is queued behind an in-flight write. */
export function setPendingLatestTick(group: MetalGroup, pending: boolean): void {
  metals[group].pendingLatestTick = pending;
}

export function recordMappingFailure(symbol: string): void {
  mappingFailures += 1;
  if (unmappedSymbols.size < 20) unmappedSymbols.add(symbol);
}

export function recordWriteAttempt(group: MetalGroup): void {
  const d = metals[group];
  d.writeAttempts += 1;
  d.writesStarted += 1;
  d.lastWriteAttempt = new Date().toISOString();
}

export function recordWriteSuccess(
  group: MetalGroup,
  affectedRows: number,
  latencyMs?: number,
  tickToWriteMs?: number,
): void {
  const d = metals[group];
  const now = new Date().toISOString();
  d.lastAffectedRows = affectedRows;
  d.lastSuccessfulWrite = now;
  d.lastDbWriteAt = now;
  d.writesSucceeded += 1;
  d.lastWriteError = null;
  if (typeof latencyMs === "number") d.lastWriteLatencyMs = latencyMs;
  if (typeof tickToWriteMs === "number" && Number.isFinite(tickToWriteMs)) {
    d.lastTickToWriteMs = tickToWriteMs;
  }
}

export function recordZeroRowUpdate(group: MetalGroup, reason: string): void {
  const d = metals[group];
  d.lastAffectedRows = 0;
  d.zeroRowUpdates += 1;
  d.writesFailed += 1;
  d.lastWriteError = reason;
}

export function recordWriteFailure(group: MetalGroup, error: string): void {
  const d = metals[group];
  d.writeFailures += 1;
  d.writesFailed += 1;
  d.lastWriteError = error;
}

/** Test helper — resets all counters. */
export function resetFeedDiagnostics(): void {
  metals.gold = empty();
  metals.silver = empty();
  mappingFailures = 0;
  unmappedSymbols.clear();
}

export function getFeedDiagnostics(): {
  gold: MetalFeedDiagnostics;
  silver: MetalFeedDiagnostics;
  mappingFailures: number;
  unmappedSymbols: string[];
  writeFailures: number;
  zeroRowUpdates: number;
} {
  return {
    gold: { ...metals.gold },
    silver: { ...metals.silver },
    mappingFailures,
    unmappedSymbols: Array.from(unmappedSymbols),
    writeFailures: metals.gold.writeFailures + metals.silver.writeFailures,
    zeroRowUpdates: metals.gold.zeroRowUpdates + metals.silver.zeroRowUpdates,
  };
}

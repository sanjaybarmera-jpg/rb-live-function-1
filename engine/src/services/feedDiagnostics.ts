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

  writeAttempts: number;
  lastWriteAttempt: string | null;
  lastSuccessfulWrite: string | null;
  lastAffectedRows: number | null;
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
    writeAttempts: 0,
    lastWriteAttempt: null,
    lastSuccessfulWrite: null,
    lastAffectedRows: null,
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

export function recordMappingFailure(symbol: string): void {
  mappingFailures += 1;
  if (unmappedSymbols.size < 20) unmappedSymbols.add(symbol);
}

export function recordWriteAttempt(group: MetalGroup): void {
  const d = metals[group];
  d.writeAttempts += 1;
  d.lastWriteAttempt = new Date().toISOString();
}

export function recordWriteSuccess(group: MetalGroup, affectedRows: number): void {
  const d = metals[group];
  d.lastAffectedRows = affectedRows;
  d.lastSuccessfulWrite = new Date().toISOString();
  d.lastWriteError = null;
}

export function recordZeroRowUpdate(group: MetalGroup, reason: string): void {
  const d = metals[group];
  d.lastAffectedRows = 0;
  d.zeroRowUpdates += 1;
  d.lastWriteError = reason;
}

export function recordWriteFailure(group: MetalGroup, error: string): void {
  const d = metals[group];
  d.writeFailures += 1;
  d.lastWriteError = error;
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

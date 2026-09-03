import type { MetalGroup } from "./metals.js";

export interface MetalFeedDiagnostics {
  ticksReceived: number;
  lastTickTime: string | null;
  lastLtp: number | null;
  lastSuccessfulSupabaseWrite: string | null;
  lastAffectedRows: number | null;
  writeFailures: number;
  mappingFailures: number;
  lastDatabaseError: string | null;
}

export interface FeedDiagnostics {
  gold: MetalFeedDiagnostics;
  silver: MetalFeedDiagnostics;
  unmappedTicks: number;
}

const createDiagnostics = (): MetalFeedDiagnostics => ({
  ticksReceived: 0,
  lastTickTime: null,
  lastLtp: null,
  lastSuccessfulSupabaseWrite: null,
  lastAffectedRows: null,
  writeFailures: 0,
  mappingFailures: 0,
  lastDatabaseError: null,
});

const state: FeedDiagnostics = {
  gold: createDiagnostics(),
  silver: createDiagnostics(),
  unmappedTicks: 0,
};

export function recordMappedTick(
  group: MetalGroup,
  ltp: number,
  receivedTs: number,
): void {
  const diagnostics = state[group];
  diagnostics.ticksReceived++;
  diagnostics.lastTickTime = new Date(receivedTs).toISOString();
  diagnostics.lastLtp = ltp;
}

export function recordMappingFailure(group?: MetalGroup): void {
  if (group) {
    state[group].mappingFailures++;
    return;
  }
  state.unmappedTicks++;
}

export function recordWriteSuccess(
  group: MetalGroup,
  affectedRows: number,
): void {
  const diagnostics = state[group];
  diagnostics.lastSuccessfulSupabaseWrite = new Date().toISOString();
  diagnostics.lastAffectedRows = affectedRows;
  diagnostics.lastDatabaseError = null;
}

export function recordWriteFailure(
  group: MetalGroup,
  error: string,
  affectedRows: number,
): void {
  const diagnostics = state[group];
  diagnostics.writeFailures++;
  diagnostics.lastAffectedRows = affectedRows;
  diagnostics.lastDatabaseError = error;
}

export function getFeedDiagnostics(): FeedDiagnostics {
  return {
    gold: { ...state.gold },
    silver: { ...state.silver },
    unmappedTicks: state.unmappedTicks,
  };
}
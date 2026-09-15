import { logger } from "../utils/logger.js";
import {
  discoverInstruments,
  validateContract,
  type DiscoveredContract,
} from "../providers/angelone/instruments.js";
import { setTokenGroup, removeTokenGroup, type MetalGroup } from "./metals.js";
import type { Instrument } from "../providers/types.js";
import type { Tick } from "../models/Tick.js";

const MCX_EXCHANGE_TYPE = 5;

/** Minimal provider surface the rollover service needs. */
export interface RolloverCapableProvider {
  getSubscribed(): Instrument[];
  subscribeInstruments(add: Instrument[]): Promise<void>;
  unsubscribeInstruments(remove: Instrument[]): Promise<void>;
  /** Optional tick-confirmation capability (Phase 2.1). */
  waitForTick?(token: string, timeoutMs: number): Promise<Tick>;
  /** Optional market-live hint: last valid non-stale tick on any token. */
  getLastValidTickTs?(): number | null;
}

export interface ActiveContract {
  group: MetalGroup;
  token: string;
  symbol: string;
  expiry: string;
}

export interface TickConfirmationState {
  pendingToken: string | null;
  waitingSince: string | null;
  timeoutMs: number;
  lastConfirmedToken: string | null;
}

export interface RolloverState {
  enabled: boolean;
  intervalMs: number;
  currentContracts: ActiveContract[];
  lastCheckTime: string | null;
  lastRolloverTime: string | null;
  lastRolloverStatus: "none" | "success" | "failed" | "skipped" | "deferred";
  lastError?: string;
  nextCheckTime: string | null;
  rolloverCount: number;
  /** Per-group outcome of the most recent check (gold/silver independence). */
  lastGroupStatus: Partial<Record<MetalGroup, string>>;
}

let state: RolloverState = {
  enabled: false,
  intervalMs: 0,
  currentContracts: [],
  lastCheckTime: null,
  lastRolloverTime: null,
  lastRolloverStatus: "none",
  nextCheckTime: null,
  rolloverCount: 0,
  lastGroupStatus: {},
};

let tickConfirmation: TickConfirmationState = {
  pendingToken: null,
  waitingSince: null,
  timeoutMs: 0,
  lastConfirmedToken: null,
};

/**
 * Tokens that were subscribed from the ENV fallback (ScripMaster outage at
 * boot). Once ScripMaster recovers and real contracts are discovered, these
 * stale tokens must be dropped so two tokens never map to the same metal.
 */
let envFallbackTokens: string[] = [];

export function setEnvFallbackTokens(tokens: string[]): void {
  envFallbackTokens = [...new Set(tokens.map((t) => String(t).trim()).filter(Boolean))];
}

export function getEnvFallbackTokens(): string[] {
  return [...envFallbackTokens];
}

export function getRolloverState(): RolloverState {
  return {
    ...state,
    currentContracts: [...state.currentContracts],
    lastGroupStatus: { ...state.lastGroupStatus },
  };
}

/** Additive, read-only tick-confirmation snapshot for /health. */
export function getTickConfirmationState(): TickConfirmationState {
  return { ...tickConfirmation };
}

/** Seed the known-active contracts (called once at boot after discovery). */
export function setActiveContracts(contracts: ActiveContract[]): void {
  state.currentContracts = [...contracts];
}

/** Test-only reset of module state. */
export function __resetRolloverState(): void {
  state = {
    enabled: false,
    intervalMs: 0,
    currentContracts: [],
    lastCheckTime: null,
    lastRolloverTime: null,
    lastRolloverStatus: "none",
    nextCheckTime: null,
    rolloverCount: 0,
    lastGroupStatus: {},
  };
  tickConfirmation = {
    pendingToken: null,
    waitingSince: null,
    timeoutMs: 0,
    lastConfirmedToken: null,
  };
  envFallbackTokens = [];
}

export interface RolloverOptions {
  provider: RolloverCapableProvider;
  enabled: boolean;
  intervalMs: number;

  /**
   * Short interval used while NO contract is active (ScripMaster was
   * unavailable at boot). Lets the engine recover a live feed in minutes
   * instead of waiting a full rollover cycle. Omit to always use intervalMs.
   */
  recoveryIntervalMs?: number;

  /** Tick confirmation timeout in ms. 0 / omitted disables confirmation. */
  tickConfirmTimeoutMs?: number;

  /** Injected for tests; defaults to real ScripMaster discovery. */
  discover?: typeof discoverInstruments;

  /**
   * Called after ScripMaster discovers a new active contract set.
   * RatesWriter uses this to update contract_symbol / contract_month /
   * expiry_date / token mapping.
   */
  onContractsChanged?: (contracts: ActiveContract[]) => void;
}

export class RolloverService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private opts: RolloverOptions) {
    state.enabled = opts.enabled;
    state.intervalMs = opts.intervalMs;
  }

  /** Recovery pace while the engine has no active contract at all. */
  private currentIntervalMs(): number {
    const recovery = this.opts.recoveryIntervalMs;
    if (recovery && recovery > 0 && state.currentContracts.length === 0) {
      return recovery;
    }
    return this.opts.intervalMs;
  }

  private schedule(): void {
    const delay = this.currentIntervalMs();
    state.intervalMs = delay;
    state.nextCheckTime = new Date(Date.now() + delay).toISOString();

    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule());
    }, delay);

    this.timer.unref?.();
  }

  /** Starts the periodic checker. Optionally runs one check immediately. */
  start(runImmediately = true): void {
    if (!this.opts.enabled) {
      logger.info("[rollover] disabled — contract switching will not run");
      return;
    }
    this.schedule();
    logger.info(
      {
        intervalMs: this.opts.intervalMs,
        recoveryIntervalMs: this.opts.recoveryIntervalMs ?? null,
        hasActiveContracts: state.currentContracts.length > 0,
      },
      "[rollover] scheduler started",
    );
    if (runImmediately) void this.check();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    state.nextCheckTime = null;
  }

  /**
   * One rollover check. Single-flighted: a check already in progress makes
   * subsequent calls no-ops so two rollovers can never interleave.
   * Gold and Silver are evaluated and switched independently.
   */
  async check(): Promise<void> {
    if (this.running) {
      logger.debug("[rollover] check already in progress — skipping");
      return;
    }
    this.running = true;
    state.lastCheckTime = new Date().toISOString();
    state.nextCheckTime = new Date(Date.now() + this.currentIntervalMs()).toISOString();
    logger.info("[rollover] checking contracts");

    try {
      const current = state.currentContracts;
      for (const c of current) {
        logger.info(
          { group: c.group, token: c.token, symbol: c.symbol, expiry: c.expiry },
          `[rollover] ${c.group} current=${c.symbol} expiry=${c.expiry}`,
        );
      }

      const discover = this.opts.discover ?? discoverInstruments;
      const result = await discover();
      const now = Date.now();

      const candidates: ActiveContract[] = [];
      for (const raw of result.contracts) {
        const contract = toActive(raw);
        const check = validateContract(contract, now);
        if (!check.ok) {
          state.lastGroupStatus[contract.group] = `rejected: ${check.reason}`;
          logger.warn(
            { group: contract.group, symbol: contract.symbol, reason: check.reason },
            "[rollover] discovered contract rejected by validation",
          );
          continue;
        }
        logger.info(
          { group: contract.group, symbol: contract.symbol, expiry: contract.expiry },
          `[rollover] ${contract.group} next contract discovered`,
        );
        candidates.push(contract);
      }

      if (candidates.length === 0) {
        state.lastRolloverStatus = state.lastRolloverStatus === "none" ? "none" : "skipped";
        logger.warn("[rollover] no valid contracts discovered — keeping current subscriptions");
        return;
      }

      const changed = candidates.filter((d) => {
        const cur = current.find((c) => c.group === d.group);
        // Never resubscribe when token and expiry are both unchanged.
        return !cur || cur.token !== d.token || cur.expiry !== d.expiry;
      });

      if (changed.length === 0) {
        state.lastRolloverStatus = state.lastRolloverStatus === "none" ? "none" : "skipped";
        for (const c of candidates) state.lastGroupStatus[c.group] = "unchanged";
        logger.info("[rollover] no rollover required");
        return;
      }

      // Each metal is switched in isolation: a Gold failure must never
      // roll back or block Silver, and vice versa.
      for (const contract of changed) {
        await this.rolloverGroup(contract);
      }
    } catch (err) {
      state.lastRolloverStatus = "failed";
      state.lastError = err instanceof Error ? err.message : String(err);
      logger.error(
        { err },
        "[rollover] discovery failed — keeping current subscriptions and live feed",
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Atomic switch for ONE metal: subscribe new first, confirm ticks, only
   * then unsubscribe the old token. Any failure restores the previous runtime
   * mapping and leaves the working subscription untouched.
   */
  private async rolloverGroup(next: ActiveContract): Promise<void> {
    const prev = state.currentContracts.find((p) => p.group === next.group) ?? null;

    logger.warn(
      {
        group: next.group,
        currentContract: prev ? `${prev.symbol} (${prev.token}, ${prev.expiry})` : "none",
        newContract: `${next.symbol} (${next.token}, ${next.expiry})`,
        reason: prev ? "nearer active contract available / expiry rolled" : "no active contract",
      },
      `[rollover] switching ${next.group} token`,
    );

    const addition: Instrument = { exchangeType: MCX_EXCHANGE_TYPE, token: next.token };

    // Stale ENV-fallback tokens for this metal are dropped together with the
    // previous contract once a real discovered contract takes over.
    const staleTokens = new Set<string>();
    if (prev && prev.token !== next.token) staleTokens.add(prev.token);
    for (const t of envFallbackTokens) {
      if (t !== next.token && (!prev || t !== prev.token)) {
        // Only drop ENV tokens that resolve to this metal group.
        if (prev ? prev.group === next.group : true) staleTokens.add(t);
      }
    }

    try {
      // 1. Prepare runtime mapping BEFORE ticks can arrive for the new token.
      setTokenGroup(next.token, next.group);

      // 2. Subscribe the new contract (never an empty list, never a reconnect).
      await this.opts.provider.subscribeInstruments([addition]);

      // 3. Verify the new token is actually in the active subscription list.
      const active = new Set(
        this.opts.provider.getSubscribed().map((i) => `${i.exchangeType}:${i.token}`),
      );
      if (!active.has(`${addition.exchangeType}:${addition.token}`)) {
        throw new Error(`subscription not registered for token: ${next.token}`);
      }
      logger.info({ group: next.group, token: next.token }, "[rollover] subscription updated");

      // 4. Wait for the first valid, non-stale tick before dropping the old token.
      const confirm = await this.confirmTicks(next);
      if (!confirm.ok) {
        try {
          await this.opts.provider.unsubscribeInstruments([addition]);
        } catch (unsubErr) {
          logger.warn({ err: unsubErr }, "[rollover] could not unsubscribe unconfirmed contract");
        }
        removeTokenGroup(next.token);
        if (prev) setTokenGroup(prev.token, prev.group);
        state.lastRolloverStatus = confirm.deferred ? "deferred" : "failed";
        state.lastError = confirm.reason;
        state.lastGroupStatus[next.group] = confirm.deferred
          ? `deferred: ${confirm.reason}`
          : `failed: ${confirm.reason}`;
        logger.warn(
          { group: next.group, reason: confirm.reason },
          confirm.deferred
            ? "[rollover] rollover deferred — retry on next scheduled check"
            : "[rollover] rollover failed — old contract kept active",
        );
        return;
      }

      // 5. Only now drop the old / stale tokens for this metal.
      const removals: Instrument[] = [...staleTokens].map((token) => ({
        exchangeType: MCX_EXCHANGE_TYPE,
        token,
      }));
      if (removals.length > 0) {
        await this.opts.provider.unsubscribeInstruments(removals);
        for (const r of removals) removeTokenGroup(r.token);
        envFallbackTokens = envFallbackTokens.filter((t) => !staleTokens.has(t));
        logger.info({ group: next.group, removals }, "[rollover] old contract unsubscribed");
      }

      // 6. Update the active contract list for this metal only.
      state.currentContracts = [
        ...state.currentContracts.filter((p) => p.group !== next.group),
        next,
      ];
      state.lastRolloverTime = new Date().toISOString();
      state.lastRolloverStatus = "success";
      state.lastGroupStatus[next.group] = "success";
      state.rolloverCount++;
      delete state.lastError;

      // 7. Push fresh contract metadata to RatesWriter immediately.
      try {
        this.opts.onContractsChanged?.([...state.currentContracts]);
      } catch (callbackErr) {
        logger.error({ err: callbackErr }, "[rollover] contract metadata callback failed");
      }

      logger.info(
        { group: next.group, contract: next },
        "[rollover] rollover successful",
      );
    } catch (err) {
      // Restore runtime mapping; subscriptions are left as-is so the engine
      // never ends up with zero contracts for this metal.
      removeTokenGroup(next.token);
      if (prev) setTokenGroup(prev.token, prev.group);
      state.lastRolloverStatus = "failed";
      state.lastError = err instanceof Error ? err.message : String(err);
      state.lastGroupStatus[next.group] = `failed: ${state.lastError}`;
      logger.error(
        { err, group: next.group },
        "[rollover] rollover failed — previous state restored",
      );
    }
  }

  /**
   * Waits for the first valid, non-stale tick on the newly subscribed token.
   * Returns ok when confirmation succeeds, is unavailable, or is not required.
   * `deferred` marks non-failures (market closed / websocket disconnected).
   */
  private async confirmTicks(
    c: ActiveContract,
  ): Promise<{ ok: boolean; deferred?: boolean; reason?: string }> {
    const timeoutMs = this.opts.tickConfirmTimeoutMs ?? 0;
    const waitForTick = this.opts.provider.waitForTick?.bind(this.opts.provider);
    if (!waitForTick || timeoutMs <= 0) {
      // Preserve pre-2.1 behaviour when confirmation is unavailable.
      logger.info("[rollover] tick confirmation unavailable — proceeding without it");
      return { ok: true };
    }

    const startedAt = Date.now();
    tickConfirmation = {
      pendingToken: c.token,
      waitingSince: new Date(startedAt).toISOString(),
      timeoutMs,
      lastConfirmedToken: tickConfirmation.lastConfirmedToken,
    };
    logger.info(
      { token: c.token, symbol: c.symbol, timeoutMs },
      "[rollover] waiting for first tick",
    );

    try {
      const tick = await waitForTick(c.token, timeoutMs);
      tickConfirmation = {
        pendingToken: null,
        waitingSince: null,
        timeoutMs,
        lastConfirmedToken: c.token,
      };
      logger.info(
        { token: c.token, ltp: tick.ltp, waitedMs: Date.now() - startedAt },
        "[rollover] tick confirmation received",
      );
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tickConfirmation = {
        pendingToken: null,
        waitingSince: null,
        timeoutMs,
        lastConfirmedToken: tickConfirmation.lastConfirmedToken,
      };

      if (message.includes("disconnected")) {
        logger.warn({ token: c.token }, "[rollover] rollover aborted — websocket disconnected");
        return { ok: false, deferred: true, reason: "websocket disconnected" };
      }

      // Market-closed heuristic: no token produced a live tick during the wait.
      const lastValid = this.opts.provider.getLastValidTickTs?.() ?? null;
      const marketClosed = lastValid === null || lastValid < startedAt;
      if (marketClosed) {
        logger.warn(
          { token: c.token, lastValidTickTs: lastValid },
          "[rollover] rollover deferred — market closed",
        );
        return { ok: false, deferred: true, reason: "market closed — no live ticks" };
      }

      logger.error({ token: c.token, timeoutMs }, "[rollover] tick confirmation timeout");
      return { ok: false, reason: "tick confirmation timeout" };
    }
  }
}

export function toActive(c: DiscoveredContract): ActiveContract {
  return { group: c.group, token: c.token, symbol: c.symbol, expiry: c.expiry };
}

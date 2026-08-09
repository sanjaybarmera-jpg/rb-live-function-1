import { logger } from "../utils/logger.js";
import { discoverInstruments, type DiscoveredContract } from "../providers/angelone/instruments.js";
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
};

let tickConfirmation: TickConfirmationState = {
  pendingToken: null,
  waitingSince: null,
  timeoutMs: 0,
  lastConfirmedToken: null,
};

export function getRolloverState(): RolloverState {
  return { ...state, currentContracts: [...state.currentContracts] };
}

/** Additive, read-only tick-confirmation snapshot for /health. */
export function getTickConfirmationState(): TickConfirmationState {
  return { ...tickConfirmation };
}

/** Seed the known-active contracts (called once at boot after discovery). */
export function setActiveContracts(contracts: ActiveContract[]): void {
  state.currentContracts = [...contracts];
}

export interface RolloverOptions {
  provider: RolloverCapableProvider;
  enabled: boolean;
  intervalMs: number;
  /** Tick confirmation timeout in ms. 0 / omitted disables confirmation. */
  tickConfirmTimeoutMs?: number;
}


export class RolloverService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private opts: RolloverOptions) {
    state.enabled = opts.enabled;
    state.intervalMs = opts.intervalMs;
  }

  /** Starts the periodic checker. Optionally runs one check immediately. */
  start(runImmediately = true): void {
    if (!this.opts.enabled) {
      logger.info("[rollover] disabled — contract switching will not run");
      return;
    }
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs);
    this.timer.unref?.();
    state.nextCheckTime = new Date(Date.now() + this.opts.intervalMs).toISOString();
    logger.info({ intervalMs: this.opts.intervalMs }, "[rollover] scheduler started");
    if (runImmediately) void this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    state.nextCheckTime = null;
  }

  /**
   * One rollover check. Single-flighted: a check already in progress makes
   * subsequent calls no-ops so two rollovers can never interleave.
   */
  async check(): Promise<void> {
    if (this.running) {
      logger.debug("[rollover] check already in progress — skipping");
      return;
    }
    this.running = true;
    state.lastCheckTime = new Date().toISOString();
    state.nextCheckTime = new Date(Date.now() + this.opts.intervalMs).toISOString();
    logger.info("[rollover] rollover check started");

    try {
      const current = state.currentContracts;
      logger.info({ current }, "[rollover] current contracts");

      const result = await discoverInstruments();
      const discovered: ActiveContract[] = result.contracts.map(toActive);
      logger.info({ discovered }, "[rollover] discovered contracts");

      const changed = discovered.filter((d) => {
        const cur = current.find((c) => c.group === d.group);
        // Never resubscribe when token and expiry are both unchanged.
        return !cur || cur.token !== d.token || cur.expiry !== d.expiry;
      });

      if (changed.length === 0) {
        state.lastRolloverStatus = state.lastRolloverStatus === "none" ? "none" : "skipped";
        logger.info("[rollover] no rollover required");
        return;
      }

      await this.performRollover(changed, current);
    } catch (err) {
      state.lastRolloverStatus = "failed";
      state.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "[rollover] rollover failed — keeping current subscriptions");
    } finally {
      this.running = false;
    }
  }

  /**
   * Atomic switch: subscribe new first, only then unsubscribe old. Any failure
   * restores the previous runtime mapping and leaves subscriptions untouched.
   */
  private async performRollover(
    changed: ActiveContract[],
    current: ActiveContract[],
  ): Promise<void> {
    for (const c of changed) {
      const prev = current.find((p) => p.group === c.group);
      logger.warn(
        {
          group: c.group,
          currentContract: prev ? `${prev.symbol} (${prev.token}, ${prev.expiry})` : "none",
          newContract: `${c.symbol} (${c.token}, ${c.expiry})`,
          reason: prev ? "nearer active contract available / expiry rolled" : "no active contract",
        },
        "[rollover] starting rollover",
      );
    }

    const additions: Instrument[] = changed.map((c) => ({
      exchangeType: MCX_EXCHANGE_TYPE,
      token: c.token,
    }));
    const removals: Instrument[] = current
      .filter((p) => changed.some((c) => c.group === p.group && c.token !== p.token))
      .map((p) => ({ exchangeType: MCX_EXCHANGE_TYPE, token: p.token }));

    // Snapshot for restoration on failure.
    const previousMappings = current.map((p) => ({ token: p.token, group: p.group }));

    try {
      // 1. Prepare runtime mapping BEFORE ticks can arrive for the new tokens.
      for (const c of changed) setTokenGroup(c.token, c.group);
      logger.info({ changed }, "[rollover] runtime mapping updated");

      // 2. Subscribe new contracts (never disconnect the socket).
      logger.info({ additions }, "[rollover] subscribing new contracts");
      await this.opts.provider.subscribeInstruments(additions);

      // 3. Verify the new tokens are actually in the active subscription list.
      const active = new Set(
        this.opts.provider.getSubscribed().map((i) => `${i.exchangeType}:${i.token}`),
      );
      const missing = additions.filter((i) => !active.has(`${i.exchangeType}:${i.token}`));
      if (missing.length > 0) {
        throw new Error(
          `subscription not registered for tokens: ${missing.map((m) => m.token).join(",")}`,
        );
      }

      // 3b. Wait for the first valid, non-stale tick on each new token before
      //     touching the old subscriptions (Phase 2.1 tick confirmation).
      const confirm = await this.confirmTicks(changed);
      if (!confirm.ok) {
        // Roll the new subscriptions back; the old contract keeps streaming.
        try {
          await this.opts.provider.unsubscribeInstruments(additions);
        } catch (unsubErr) {
          logger.warn({ err: unsubErr }, "[rollover] could not unsubscribe unconfirmed contracts");
        }
        for (const c of changed) removeTokenGroup(c.token);
        for (const p of previousMappings) setTokenGroup(p.token, p.group);
        state.lastRolloverStatus = confirm.deferred ? "deferred" : "failed";
        state.lastError = confirm.reason;
        logger.warn(
          { reason: confirm.reason },
          confirm.deferred
            ? "[rollover] rollover deferred — retry on next scheduled check"
            : "[rollover] rollover failed — old contract kept active",
        );
        return;
      }

      // 4. Only now drop the old contracts.
      if (removals.length > 0) {
        logger.info({ removals }, "[rollover] unsubscribing old contracts");
        await this.opts.provider.unsubscribeInstruments(removals);
        for (const r of removals) removeTokenGroup(r.token);
      }

      // 5. Update the active list.
      const next = [...current.filter((p) => !changed.some((c) => c.group === p.group)), ...changed];
      state.currentContracts = next;
      state.lastRolloverTime = new Date().toISOString();
      state.lastRolloverStatus = "success";
      state.rolloverCount++;
      delete state.lastError;
      logger.info({ contracts: next }, "[rollover] rollover complete");
    } catch (err) {
      // Restore runtime mappings exactly as they were; subscriptions are left
      // as-is so the engine never ends up with zero contracts.
      for (const c of changed) removeTokenGroup(c.token);
      for (const p of previousMappings) setTokenGroup(p.token, p.group);
      state.lastRolloverStatus = "failed";
      state.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "[rollover] rollover failed — previous state restored");
    }

  }

  /**
   * Waits for the first valid, non-stale tick on every newly subscribed token.
   * Returns ok when confirmation succeeds, is unavailable, or is not required.
   * `deferred` marks non-failures (market closed / websocket disconnected).
   */
  private async confirmTicks(
    changed: ActiveContract[],
  ): Promise<{ ok: boolean; deferred?: boolean; reason?: string }> {
    const timeoutMs = this.opts.tickConfirmTimeoutMs ?? 0;
    const waitForTick = this.opts.provider.waitForTick?.bind(this.opts.provider);
    if (!waitForTick || timeoutMs <= 0) {
      // Preserve pre-2.1 behaviour when confirmation is unavailable.
      logger.info("[rollover] tick confirmation unavailable — proceeding without it");
      return { ok: true };
    }

    for (const c of changed) {
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        tickConfirmation = {
          pendingToken: null,
          waitingSince: null,
          timeoutMs,
          lastConfirmedToken: tickConfirmation.lastConfirmedToken,
        };

        if (message.includes("disconnected")) {
          logger.warn(
            { token: c.token },
            "[rollover] rollover aborted — websocket disconnected",
          );
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

        logger.error(
          { token: c.token, timeoutMs },
          "[rollover] tick confirmation timeout",
        );
        return { ok: false, reason: "tick confirmation timeout" };
      }
    }
    return { ok: true };
  }
}


export function toActive(c: DiscoveredContract): ActiveContract {
  return { group: c.group, token: c.token, symbol: c.symbol, expiry: c.expiry };
}

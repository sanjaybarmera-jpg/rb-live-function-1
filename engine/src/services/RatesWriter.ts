import { logger } from "../utils/logger.js";
import { toIso } from "../utils/time.js";
import { getSupabase } from "./supabase.js";
import type { Tick } from "../models/Tick.js";
import {
  metalGroupForSymbol,
  metalTypesForGroup,
  type MetalGroup,
} from "./metals.js";
import { currentSessionKey, sessionKeyFor } from "./session.js";
import { sanitizeExpiryDate } from "../utils/expiry.js";
import {
  recordLtpObservation,
  recordMappingFailure,
  recordTick,
  recordWriteAttempt,
  recordWriteFailure,
  recordWriteSuccess,
  recordZeroRowUpdate,
  setPendingLatestTick,
} from "./feedDiagnostics.js";

export interface ContractMetadata {
  group: MetalGroup;
  token: string;
  contractSymbol: string;
  contractMonth: string;
  expiryDate: string;
}

interface SessionState {
  group: MetalGroup;
  sessionKey: string;

  mcx_ltp: number;
  high: number;
  low: number;
  updated_at: string;
  /** receivedTs (ms) of the tick that produced the current value. */
  tickReceivedTs?: number;

  contract_symbol: string;
  contract_month: string;
  expiry_date: string;
}

/**
 * Coalescing window before a Supabase write is issued.
 *
 * Chosen from the measured architecture, not arbitrarily:
 * a Supabase UPDATE round-trip is ~100-300ms and only ONE write per metal
 * may be in flight, so the natural write pacing is the round-trip itself.
 * The window therefore only has to absorb ticks that arrive inside the same
 * event-loop burst (Angel delivers several frames per socket read). 25ms is
 * far below the round-trip, so it adds no perceptible latency, while still
 * collapsing a burst of frames into a single write.
 */
const COALESCE_MS = 25;

/** Safety-net sweep: retries groups left dirty by a failed write. */
const RETRY_SWEEP_MS = 1000;

/** Backoff bounds applied after a failed write (per metal). */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 5000;

interface UpdateResult {
  data: { metal_type: string }[] | null;
  error: { message: string } | null;
}

/** Minimal shape of the Supabase update chain (injectable for tests). */
export interface RatesDbClient {
  from(table: string): {
    update(payload: Record<string, unknown>): {
      in(
        column: string,
        values: string[],
      ): { select(columns: string): PromiseLike<UpdateResult> };
    };
  };
}

interface GroupWriteState {
  inFlight: boolean;
  timer: NodeJS.Timeout | null;
  retryDelayMs: number;
}

const GROUPS: MetalGroup[] = ["gold", "silver"];


/**
 * RatesWriter
 *
 * IMPORTANT:
 * Contract metadata MUST come from ScripMaster discovery.
 *
 * WebSocket ticks may contain only the token, for example:
 *
 *   483079
 *
 * Therefore we NEVER try to parse contract_symbol from tick.symbol.
 *
 * ScripMaster is the source of truth for:
 *
 *   token
 *   contract_symbol
 *   contract_month
 *   expiry_date
 */
export class RatesWriter {
  private sessions = new Map<MetalGroup, SessionState>();

  private dirty = new Set<MetalGroup>();

  private timer: NodeJS.Timeout | null = null;

  /** Per-metal write state — Gold and Silver never block each other. */
  private writes = new Map<MetalGroup, GroupWriteState>();

  private lastError: string | null = null;

  private initialized = false;

  constructor(
    private coalesceMs: number = COALESCE_MS,
    private discoveredContracts: ContractMetadata[] = [],
    private db: () => RatesDbClient = () =>
      getSupabase() as unknown as RatesDbClient,
  ) {}

  private writeStateFor(group: MetalGroup): GroupWriteState {
    let w = this.writes.get(group);
    if (!w) {
      w = { inFlight: false, timer: null, retryDelayMs: 0 };
      this.writes.set(group, w);
    }
    return w;
  }

  /** Mark a metal dirty and schedule its independent low-latency write. */
  private markDirty(group: MetalGroup): void {
    this.dirty.add(group);
    this.scheduleFlush(group);
  }

  private scheduleFlush(group: MetalGroup, delayMs?: number): void {
    const w = this.writeStateFor(group);

    // A write is already running: the latest value stays in memory and is
    // written as soon as that write completes. No concurrent writes.
    if (w.inFlight) {
      setPendingLatestTick(group, true);
      return;
    }

    if (w.timer) return;

    const delay = delayMs ?? w.retryDelayMs ?? 0;

    w.timer = setTimeout(
      () => {
        w.timer = null;
        void this.flushGroup(group);
      },
      Math.max(delay, this.coalesceMs),
    );

    w.timer.unref?.();
  }

  /**
   * Replace currently discovered contracts.
   *
   * Called by rollover logic when ScripMaster discovers
   * a new Gold/Silver contract.
   */
  setDiscoveredContracts(
    contracts: ContractMetadata[],
  ): void {
    this.discoveredContracts = contracts;

    logger.info(
      {
        contracts: contracts.map((c) => ({
          group: c.group,
          token: c.token,
          symbol: c.contractSymbol,
          month: c.contractMonth,
          expiry: c.expiryDate,
        })),
      },
      "[rates] discovered contracts updated",
    );

    /*
     * Immediately update the in-memory session metadata.
     *
     * This is important during rollover because we don't want
     * to wait for the first tick before changing contract metadata.
     */
    for (const contract of contracts) {
      const state = this.sessions.get(contract.group);

      if (!state) continue;

      const changed =
        state.contract_symbol !== contract.contractSymbol ||
        state.contract_month !== contract.contractMonth ||
        state.expiry_date !== contract.expiryDate;

      if (!changed) continue;

      logger.info(
        {
          group: contract.group,
          previousContract: state.contract_symbol,
          newContract: contract.contractSymbol,
          contractMonth: contract.contractMonth,
          expiryDate: contract.expiryDate,
        },
        "[rates] applying new discovered contract",
      );

      state.contract_symbol = contract.contractSymbol;
      state.contract_month = contract.contractMonth;
      state.expiry_date = contract.expiryDate;

      this.markDirty(contract.group);
    }

    /*
     * If writer is already initialized, flush metadata immediately.
     */
    if (this.initialized && this.dirty.size > 0) {
      void this.flush();
    }
  }

  /**
   * Find discovered contract for a metal group.
   */
  private getDiscoveredContract(
    group: MetalGroup,
  ): ContractMetadata | undefined {
    return this.discoveredContracts.find(
      (contract) => contract.group === group,
    );
  }

  /**
   * Restore today's session state from Supabase.
   *
   * IMPORTANT:
   * DB contract metadata is NEVER allowed to override
   * freshly discovered ScripMaster metadata.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.initialized = true;

    const key = currentSessionKey();

    for (const group of GROUPS) {
      const metalType =
        metalTypesForGroup(group)[0] as string;

      const discovered =
        this.getDiscoveredContract(group);

      try {
        const { data, error } = await getSupabase()
          .from("rates")
          .select(
            "mcx_ltp, high, low, updated_at, contract_symbol, contract_month, expiry_date",
          )
          .eq("metal_type", metalType)
          .maybeSingle();

        if (error) {
          logger.warn(
            {
              err: error.message,
              group,
            },
            "[rates] session restore query failed",
          );

          continue;
        }

        /*
         * No DB row.
         *
         * That's okay. The first live tick will initialize it.
         * But discovered contract metadata is already known.
         */
        if (!data) {
          logger.info(
            {
              group,
              contract: discovered?.contractSymbol,
            },
            "[rates] no DB state — waiting for first live tick",
          );

          continue;
        }

        const updatedAt = data.updated_at
          ? Date.parse(data.updated_at as string)
          : NaN;

        const high = Number(data.high);
        const low = Number(data.low);

        /*
         * Today's session only.
         */
        if (
          !Number.isFinite(updatedAt) ||
          sessionKeyFor(updatedAt) !== key ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          high <= 0 ||
          low <= 0
        ) {
          logger.info(
            {
              group,
              sessionKey: key,
            },
            "[rates] no usable session state in DB — waiting for first live tick",
          );

          continue;
        }

        /*
         * CONTRACT METADATA PRIORITY:
         *
         * 1. ScripMaster discovered contract
         * 2. DB metadata only as fallback
         *
         * This prevents old DB contracts from overriding
         * a freshly discovered contract.
         */
        const contractSymbol =
          discovered?.contractSymbol ??
          String(data.contract_symbol ?? "");

        const contractMonth =
          discovered?.contractMonth ??
          String(data.contract_month ?? "");

        /*
         * expiry_date must ALWAYS be a strict ISO date.
         *
         * A DB row may still contain a value persisted by an
         * older engine version (raw ScripMaster text appended
         * to an ISO prefix). Never trust it: accept strict ISO,
         * otherwise re-parse from the contract symbol.
         */
        const expiryDate =
          discovered?.expiryDate ??
          sanitizeExpiryDate(
            String(data.expiry_date ?? ""),
            contractSymbol,
          );

        this.sessions.set(group, {
          group,
          sessionKey: key,

          mcx_ltp:
            Number(data.mcx_ltp) > 0
              ? Number(data.mcx_ltp)
              : low,

          high,
          low,

          updated_at: toIso(updatedAt),

          contract_symbol: contractSymbol,
          contract_month: contractMonth,
          expiry_date: expiryDate,
        });

        logger.info(
          {
            group,
            sessionKey: key,

            high,
            low,

            dbContractSymbol:
              data.contract_symbol,

            contract_symbol:
              contractSymbol,

            contract_month:
              contractMonth,

            expiry_date:
              expiryDate,

            source:
              discovered
                ? "scripmaster"
                : "db",
          },
          "[rates] session restored from DB",
        );

        /*
         * If DB contains old contract metadata,
         * schedule an immediate correction.
         */
        if (
          discovered &&
          (
            String(data.contract_symbol ?? "") !==
              discovered.contractSymbol ||
            String(data.contract_month ?? "") !==
              discovered.contractMonth ||
            String(data.expiry_date ?? "") !==
              discovered.expiryDate
          )
        ) {
          logger.info(
            {
              group,

              previousContract:
                data.contract_symbol,

              newContract:
                discovered.contractSymbol,

              contractMonth:
                discovered.contractMonth,

              expiryDate:
                discovered.expiryDate,
            },
            "[rates] discovered contract differs from DB — scheduling metadata update",
          );

          this.dirty.add(group);
        }
      } catch (err) {
        logger.warn(
          {
            err:
              err instanceof Error
                ? err.message
                : String(err),

            group,
          },
          "[rates] session restore failed",
        );
      }
    }

    /*
     * Write discovered metadata immediately.
     */
    if (this.dirty.size > 0) {
      await this.flush();
    }
  }

  start(): void {
    if (this.timer) return;

    /*
     * Writes are tick-driven (see markDirty/scheduleFlush).
     * This interval is only a safety net that picks up a group left
     * dirty by a failed write when no further ticks arrive.
     */
    this.timer = setInterval(() => {
      for (const group of this.dirty) this.scheduleFlush(group);
    }, RETRY_SWEEP_MS);

    this.timer.unref?.();

    logger.info(
      {
        coalesceMs: this.coalesceMs,
        retrySweepMs: RETRY_SWEEP_MS,
      },
      "[rates] low-latency writer started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const w of this.writes.values()) {
      if (w.timer) {
        clearTimeout(w.timer);
        w.timer = null;
      }
    }

    await this.flush();

    logger.info(
      "[rates] low-latency writer stopped",
    );
  }

  /**
   * Process a live Angel One tick.
   *
   * IMPORTANT:
   * tick.symbol is NOT trusted for contract metadata.
   *
   * We use the MetalGroup from the tick and then obtain
   * contract metadata from ScripMaster discovery.
   */
  write(tick: Tick): void {
    const group =
      metalGroupForSymbol(tick.symbol);

    if (!group) {
      recordMappingFailure(tick.symbol);
      return;
    }

    const tsMs =
      tick.exchangeTs ??
      tick.receivedTs;

    const key =
      sessionKeyFor(tsMs);

    const ts =
      toIso(tsMs);

    recordTick(group, tick.symbol, tick.ltp, ts);


    let state =
      this.sessions.get(group);

    const discovered =
      this.getDiscoveredContract(group);

    /*
     * First live tick for this group.
     */
    if (!state) {
      /*
       * NEVER write blank expiry_date.
       *
       * Discovery must provide the contract.
       */
      if (!discovered) {
        logger.warn(
          {
            group,
            tickSymbol: tick.symbol,
          },
          "[rates] live tick received but no discovered contract exists",
        );

        return;
      }

      state = {
        group,
        sessionKey: key,

        mcx_ltp: tick.ltp,

        high: tick.ltp,
        low: tick.ltp,

        updated_at: ts,

        contract_symbol:
          discovered.contractSymbol,

        contract_month:
          discovered.contractMonth,

        expiry_date:
          discovered.expiryDate,
      };

      this.sessions.set(
        group,
        state,
      );

      logger.info(
        {
          group,
          sessionKey: key,

          token:
            discovered.token,

          high:
            state.high,

          low:
            state.low,

          contract_symbol:
            state.contract_symbol,

          contract_month:
            state.contract_month,

          expiry_date:
            state.expiry_date,
        },
        "[rates] session initialized",
      );

      state.tickReceivedTs = tick.receivedTs;
      recordLtpObservation(group, true);
      this.markDirty(group);

      return;
    }

    /*
     * Always synchronize contract metadata from
     * current ScripMaster discovery.
     *
     * This is what makes rollover safe.
     */
    if (discovered) {
      const contractChanged =
        state.contract_symbol !==
          discovered.contractSymbol ||
        state.contract_month !==
          discovered.contractMonth ||
        state.expiry_date !==
          discovered.expiryDate;

      if (contractChanged) {
        logger.info(
          {
            group,

            previousContract:
              state.contract_symbol,

            newContract:
              discovered.contractSymbol,

            token:
              discovered.token,

            contractMonth:
              discovered.contractMonth,

            expiryDate:
              discovered.expiryDate,
          },
          "[rates] contract changed via discovery",
        );

        state.contract_symbol =
          discovered.contractSymbol;

        state.contract_month =
          discovered.contractMonth;

        state.expiry_date =
          discovered.expiryDate;

        this.markDirty(group);
      }
    }

    /*
     * New MCX trading session.
     */
    if (state.sessionKey !== key) {
      logger.info(
        {
          group,

          previousSession:
            state.sessionKey,

          newSession:
            key,

          previousHigh:
            state.high,

          previousLow:
            state.low,
        },
        "[rates] new MCX session detected",
      );

      state.sessionKey = key;

      state.high = tick.ltp;
      state.low = tick.ltp;

      logger.info(
        {
          group,
          sessionKey: key,
          high: state.high,
          low: state.low,
        },
        "[rates] session reset",
      );
    } else {
      /*
       * New session high.
       */
      if (tick.ltp > state.high) {
        state.high = tick.ltp;

        logger.debug(
          {
            group,
            sessionKey: key,
            high: state.high,
          },
          "[rates] new session high",
        );
      }

      /*
       * New session low.
       */
      if (tick.ltp < state.low) {
        state.low = tick.ltp;

        logger.debug(
          {
            group,
            sessionKey: key,
            low: state.low,
          },
          "[rates] new session low",
        );
      }
    }

    /*
     * Update live price.
     *
     * A genuine change (even ₹1) is always eligible for an immediate write.
     * An identical LTP is counted as a duplicate and does NOT create a write.
     */
    const ltpChanged = state.mcx_ltp !== tick.ltp;

    state.mcx_ltp = tick.ltp;
    state.updated_at = ts;
    state.tickReceivedTs = tick.receivedTs;

    recordLtpObservation(group, ltpChanged);

    if (ltpChanged) {
      this.markDirty(group);
    } else if (this.dirty.has(group)) {
      // Metadata/session change already pending — keep it scheduled.
      this.scheduleFlush(group);
    }
  }

  /**
   * Write one metal to Supabase.
   *
   * At most ONE write per metal is in flight. Ticks arriving during a write
   * update the in-memory state, and the latest value is written immediately
   * after the current write completes — nothing is lost, nothing piles up.
   * Gold and Silver have fully independent state, so neither blocks the other.
   */
  private async flushGroup(group: MetalGroup): Promise<void> {
    const w = this.writeStateFor(group);

    if (w.inFlight) return;
    if (!this.dirty.has(group)) return;

    const state = this.sessions.get(group);

    if (!state) {
      this.dirty.delete(group);
      return;
    }

    this.dirty.delete(group);
    w.inFlight = true;
    setPendingLatestTick(group, false);

    const targets = metalTypesForGroup(group) as string[];
    const startedAt = Date.now();

    try {
      /*
       * SAFETY:
       *
       * Never send blank expiry_date to PostgreSQL.
       */
      const metadataValid =
        !!state.contract_symbol &&
        !!state.expiry_date &&
        /^\d{4}-\d{2}-\d{2}$/.test(state.expiry_date);

      if (!metadataValid) {
        /*
         * Contract metadata is unusable, but the LIVE PRICE must
         * still reach Supabase. We write price fields only and
         * leave existing contract metadata untouched.
         */
        logger.error(
          {
            group,
            contract_symbol: state.contract_symbol,
            contract_month: state.contract_month,
            expiry_date: state.expiry_date,
          },
          "[rates] contract metadata invalid — writing price fields only",
        );
      }

      const payload: Record<string, unknown> = {
        mcx_ltp: state.mcx_ltp,
        high: state.high,
        low: state.low,
        updated_at: state.updated_at,
      };

      if (metadataValid) {
        payload["contract_symbol"] = state.contract_symbol;
        payload["contract_month"] = state.contract_month;
        payload["expiry_date"] = state.expiry_date;
      }

      recordWriteAttempt(group);

      logger.debug(
        {
          group,
          token: this.getDiscoveredContract(group)?.token,
          mcx_ltp: state.mcx_ltp,
          where: `metal_type IN (${targets.join(", ")})`,
          metadataValid,
        },
        "[rates] supabase update attempt",
      );

      const { data, error } = await this.db()
        .from("rates")
        .update(payload)
        .in("metal_type", targets)
        .select("metal_type");

      const latencyMs = Date.now() - startedAt;

      if (error) {
        this.lastError = error.message;
        recordWriteFailure(group, error.message);

        logger.error(
          {
            err: error.message,
            group,
            where: `metal_type IN (${targets.join(", ")})`,
            latencyMs,
          },
          "[rates] update failed",
        );

        this.dirty.add(group);
        this.backoff(w);
        return;
      }

      const affectedRows = data?.length ?? 0;

      if (affectedRows === 0) {
        const reason = `update matched 0 rows for metal_type IN (${targets.join(", ")}) — no such rows in rates, or RLS/service-role key blocking the update`;

        this.lastError = reason;
        recordZeroRowUpdate(group, reason);

        logger.error(
          {
            group,
            where: `metal_type IN (${targets.join(", ")})`,
            affectedRows: 0,
          },
          "[rates] update affected 0 rows — treating as FAILURE",
        );

        this.dirty.add(group);
        this.backoff(w);
        return;
      }

      const tickToWriteMs = state.tickReceivedTs
        ? startedAt - state.tickReceivedTs
        : undefined;

      recordWriteSuccess(group, affectedRows, latencyMs, tickToWriteMs);
      w.retryDelayMs = 0;

      logger.debug(
        {
          group,
          affectedRows,
          token: this.getDiscoveredContract(group)?.token,
          mcx_ltp: state.mcx_ltp,
          updated_at: state.updated_at,
          tickToWriteMs,
          dbLatencyMs: latencyMs,
        },
        "[rates] supabase update succeeded",
      );

      this.lastError = null;
    } catch (err) {
      this.lastError =
        err instanceof Error ? err.message : String(err);

      recordWriteFailure(group, this.lastError);

      logger.error(
        { err: this.lastError, group },
        "[rates] write failed",
      );

      // Latest in-memory value is retained and retried.
      this.dirty.add(group);
      this.backoff(w);
    } finally {
      w.inFlight = false;

      if (this.dirty.has(group)) {
        // Newest value (or a retry) goes out as soon as allowed.
        this.scheduleFlush(group);
      } else {
        setPendingLatestTick(group, false);
      }
    }
  }

  private backoff(w: GroupWriteState): void {
    w.retryDelayMs = Math.min(
      w.retryDelayMs > 0 ? w.retryDelayMs * 2 : RETRY_BASE_MS,
      RETRY_MAX_MS,
    );
  }

  /** Flush every pending metal. Gold and Silver are written in parallel. */
  async flush(): Promise<void> {
    await Promise.all(GROUPS.map((group) => this.flushGroup(group)));
  }

  get pending(): number {
    return this.dirty.size;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

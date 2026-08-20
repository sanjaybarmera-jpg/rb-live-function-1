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

  // Current MCX futures contract metadata
  contract_symbol: string;
  contract_month: string;
  expiry_date: string;
}

const FLUSH_INTERVAL_MS = 250;

const GROUPS: MetalGroup[] = ["gold", "silver"];

const MONTHS: Record<string, string> = {
  JAN: "January",
  FEB: "February",
  MAR: "March",
  APR: "April",
  MAY: "May",
  JUN: "June",
  JUL: "July",
  AUG: "August",
  SEP: "September",
  OCT: "October",
  NOV: "November",
  DEC: "December",
};

/**
 * Parse a standard MCX futures symbol.
 *
 * Examples:
 *
 * GOLD05OCT26FUT
 * SILVER04SEP26FUT
 * GOLDM28AUG26FUT
 */
function parseContract(
  symbol: string,
): {
  contractSymbol: string;
  contractMonth: string;
  expiryDate: string;
} | null {
  const normalized = symbol.trim().toUpperCase();

  const match =
    /^(GOLD|GOLDM|SILVER|SILVERM)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})FUT$/.exec(
      normalized,
    );

  if (!match) {
    return null;
  }

  const day = Number(match[2]);
  const monthCode = match[3];
  const year = 2000 + Number(match[4]);

  if (!monthCode) {
    return null;
  }

  const monthName = MONTHS[monthCode];

  if (!monthName) {
    return null;
  }

  const monthNumber: Record<string, string> = {
    JAN: "01",
    FEB: "02",
    MAR: "03",
    APR: "04",
    MAY: "05",
    JUN: "06",
    JUL: "07",
    AUG: "08",
    SEP: "09",
    OCT: "10",
    NOV: "11",
    DEC: "12",
  };

  const monthNumberValue = monthNumber[monthCode];

  if (!monthNumberValue) {
    return null;
  }

  return {
    contractSymbol: normalized,
    contractMonth: `${monthName} ${year}`,
    expiryDate: `${year}-${monthNumberValue}-${String(day).padStart(2, "0")}`,
  };
}

export class RatesWriter {
  private sessions = new Map<MetalGroup, SessionState>();

  private dirty = new Set<MetalGroup>();

  private timer: NodeJS.Timeout | null = null;

  private flushing = false;

  private lastError: string | null = null;

  private initialized = false;

  constructor(
    private flushIntervalMs: number = FLUSH_INTERVAL_MS,
    private discoveredContracts: ContractMetadata[] = [],
  ) {}

  /**
   * Find currently discovered contract for a metal group.
   *
   * AUTO discovery is the source of truth.
   */
  private getDiscoveredContract(
    group: MetalGroup,
    tickSymbol?: string,
  ): ContractMetadata | undefined {
    const normalized = String(tickSymbol ?? "")
      .trim()
      .toUpperCase();

    /*
     * First preference:
     * Match by token.
     *
     * Angel One WebSocket tick may expose the token instead
     * of the full contract symbol.
     */
    const byToken = this.discoveredContracts.find(
      (contract) =>
        contract.group === group &&
        normalized !== "" &&
        contract.token === normalized,
    );

    if (byToken) {
      return byToken;
    }

    /*
     * Second preference:
     * Match by full contract symbol.
     */
    const bySymbol = this.discoveredContracts.find(
      (contract) =>
        contract.group === group &&
        normalized !== "" &&
        contract.contractSymbol.toUpperCase() === normalized,
    );

    return bySymbol;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    this.initialized = true;

    const key = currentSessionKey();

    for (const group of GROUPS) {
      const metalType = metalTypesForGroup(group)[0] as string;

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

        if (!data) {
          continue;
        }

        const updatedAt = data.updated_at
          ? Date.parse(data.updated_at as string)
          : NaN;

        const high = Number(data.high);
        const low = Number(data.low);

        if (
          !isFinite(updatedAt) ||
          sessionKeyFor(updatedAt) !== key ||
          !isFinite(high) ||
          !isFinite(low) ||
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
         * ScripMaster discovery is ALWAYS the source of truth
         * for the current contract in AUTO mode.
         */
        const discovered = this.discoveredContracts.find(
          (contract) => contract.group === group,
        );

        const contractSymbol =
          discovered?.contractSymbol ??
          String(data.contract_symbol ?? "");

        const contractMonth =
          discovered?.contractMonth ??
          String(data.contract_month ?? "");

        const expiryDate =
          discovered?.expiryDate ??
          String(data.expiry_date ?? "");

        this.sessions.set(group, {
          group,
          sessionKey: key,
          mcx_ltp: Number(data.mcx_ltp) || low,
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

            dbContractSymbol: data.contract_symbol,

            contract_symbol: contractSymbol,
            contract_month: contractMonth,
            expiry_date: expiryDate,

            source: discovered ? "scripmaster" : "db",
          },
          "[rates] session restored from DB",
        );

        /*
         * If discovery has found a different contract,
         * schedule metadata update immediately.
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

              previousContract: data.contract_symbol,

              newContract: discovered.contractSymbol,
              token: discovered.token,
              contractMonth: discovered.contractMonth,
              expiryDate: discovered.expiryDate,
            },
            "[rates] discovered contract differs from DB — scheduling metadata update",
          );

          this.dirty.add(group);
        }
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            group,
          },
          "[rates] session restore failed",
        );
      }
    }

    /*
     * Immediately write discovered contract metadata.
     */
    if (this.dirty.size > 0) {
      await this.flush();
    }
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    logger.info(
      {
        flushIntervalMs: this.flushIntervalMs,
      },
      "[rates] buffered writer started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    await this.flush();

    logger.info("[rates] buffered writer stopped");
  }

  write(tick: Tick): void {
    const group = metalGroupForSymbol(tick.symbol);

    if (!group) {
      return;
    }

    const tsMs = tick.exchangeTs ?? tick.receivedTs;

    const key = sessionKeyFor(tsMs);

    const ts = toIso(tsMs);

    let state = this.sessions.get(group);

    /*
     * IMPORTANT:
     *
     * Angel One tick.symbol may be:
     *
     *   483079
     *
     * instead of:
     *
     *   GOLD05OCT26FUT
     *
     * Therefore we MUST use the discovered token mapping.
     */
    const discovered = this.getDiscoveredContract(
      group,
      tick.symbol,
    );

    /*
     * Only use parseContract when the tick actually contains
     * a full contract symbol.
     */
    const parsed = discovered
      ? null
      : parseContract(tick.symbol);

    /*
     * Resolve contract metadata.
     *
     * Priority:
     *
     * 1. ScripMaster discovered contract
     * 2. Full symbol parsed from tick
     * 3. Existing session metadata
     */
    const contractSymbol =
      discovered?.contractSymbol ??
      parsed?.contractSymbol ??
      state?.contract_symbol ??
      "";

    const contractMonth =
      discovered?.contractMonth ??
      parsed?.contractMonth ??
      state?.contract_month ??
      "";

    const expiryDate =
      discovered?.expiryDate ??
      parsed?.expiryDate ??
      state?.expiry_date ??
      "";

    /*
     * If this is the first tick of the session.
     */
    if (!state) {
      state = {
        group,
        sessionKey: key,

        mcx_ltp: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,

        updated_at: ts,

        contract_symbol: contractSymbol,
        contract_month: contractMonth,
        expiry_date: expiryDate,
      };

      this.sessions.set(group, state);

      logger.info(
        {
          group,
          sessionKey: key,

          token: discovered?.token ?? tick.symbol,

          high: state.high,
          low: state.low,

          contract_symbol: state.contract_symbol,
          contract_month: state.contract_month,
          expiry_date: state.expiry_date,
        },
        "[rates] session initialized",
      );

      this.dirty.add(group);

      return;
    }

    /*
     * AUTO ROLLOVER CONTRACT UPDATE
     *
     * When discovery switches from:
     *
     * OLD TOKEN
     *      ↓
     * NEW TOKEN
     *
     * the next tick will resolve to the new discovered
     * contract metadata automatically.
     */
    if (
      contractSymbol &&
      state.contract_symbol !== contractSymbol
    ) {
      logger.info(
        {
          group,

          previousContract: state.contract_symbol,

          newContract: contractSymbol,

          token: discovered?.token ?? tick.symbol,

          contractMonth,
          expiryDate,
        },
        "[rates] contract changed",
      );

      state.contract_symbol = contractSymbol;
      state.contract_month = contractMonth;
      state.expiry_date = expiryDate;
    } else if (discovered) {
      /*
       * Keep metadata synchronized even when symbol did not change.
       */
      state.contract_symbol = discovered.contractSymbol;
      state.contract_month = discovered.contractMonth;
      state.expiry_date = discovered.expiryDate;
    }

    /*
     * New MCX trading session.
     */
    if (state.sessionKey !== key) {
      logger.info(
        {
          group,

          previousSession: state.sessionKey,
          newSession: key,

          previousHigh: state.high,
          previousLow: state.low,
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
       * Session high.
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
       * Session low.
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
     * Update live MCX price.
     */
    state.mcx_ltp = tick.ltp;

    state.updated_at = ts;

    this.dirty.add(group);
  }

  async flush(): Promise<void> {
    if (
      this.flushing ||
      this.dirty.size === 0
    ) {
      return;
    }

    this.flushing = true;

    const groups = Array.from(this.dirty);

    this.dirty.clear();

    try {
      for (const group of groups) {
        const state = this.sessions.get(group);

        if (!state) {
          continue;
        }

        /*
         * IMPORTANT:
         *
         * Never send empty string to PostgreSQL DATE column.
         *
         * In AUTO mode discoveredContracts should always provide
         * valid expiryDate.
         *
         * If metadata is somehow unavailable, don't overwrite
         * an existing valid date with "".
         */
        const updateData: Record<string, unknown> = {
          mcx_ltp: state.mcx_ltp,
          high: state.high,
          low: state.low,
          updated_at: state.updated_at,
          contract_symbol: state.contract_symbol,
          contract_month: state.contract_month,
        };

        if (state.expiry_date) {
          updateData.expiry_date = state.expiry_date;
        }

        const { error } = await getSupabase()
          .from("rates")
          .update(updateData)
          .in(
            "metal_type",
            metalTypesForGroup(group) as string[],
          );

        if (error) {
          this.lastError = error.message;

          logger.error(
            {
              err: error.message,
              group,

              contract_symbol: state.contract_symbol,
              contract_month: state.contract_month,
              expiry_date: state.expiry_date,

              mcx_ltp: state.mcx_ltp,
            },
            "[rates] update failed",
          );

          /*
           * Don't lose update.
           * Retry next flush.
           */
          this.dirty.add(group);

          continue;
        }

        logger.debug(
          {
            group,

            token: this.discoveredContracts.find(
              (contract) => contract.group === group,
            )?.token,

            contract_symbol: state.contract_symbol,
            contract_month: state.contract_month,
            expiry_date: state.expiry_date,

            mcx_ltp: state.mcx_ltp,
          },
          "[rates] rate + contract metadata updated",
        );

        this.lastError = null;
      }
    } catch (err) {
      this.lastError =
        err instanceof Error
          ? err.message
          : String(err);

      logger.error(
        {
          err: this.lastError,
        },
        "[rates] flush failed",
      );

      /*
       * Retry all groups.
       */
      for (const group of groups) {
        this.dirty.add(group);
      }
    } finally {
      this.flushing = false;
    }
  }

  get pending(): number {
    return this.dirty.size;
  }

  get healthy(): boolean {
    return this.lastError === null;
  }
}

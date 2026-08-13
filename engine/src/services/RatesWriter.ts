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
 * Extract contract metadata from symbols such as:
 *
 * GOLD05OCT26FUT
 * SILVER04SEP26FUT
 * GOLDM28AUG26FUT
 */
function parseContract(symbol: string): {
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

  return {
    contractSymbol: normalized,
    contractMonth: `${monthName} ${year}`,
    expiryDate: `${year}-${monthNumber[monthCode]}-${String(day).padStart(2, "0")}`,
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
            { err: error.message, group },
            "[rates] session restore query failed",
          );
          continue;
        }

        if (!data) continue;

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
            { group, sessionKey: key },
            "[rates] no usable session state in DB — waiting for first live tick",
          );
          continue;
        }

        /*
         * IMPORTANT:
         * ScripMaster discovery is the source of truth for the CURRENT
         * contract. Never allow an old contract stored in rates to override
         * the freshly discovered contract.
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
         * If ScripMaster found a newer contract than the DB, mark the group
         * dirty so the new metadata gets written immediately.
         */
        if (
          discovered &&
          (
            String(data.contract_symbol ?? "") !== discovered.contractSymbol ||
            String(data.contract_month ?? "") !== discovered.contractMonth ||
            String(data.expiry_date ?? "") !== discovered.expiryDate
          )
        ) {
          logger.info(
            {
              group,
              previousContract: data.contract_symbol,
              newContract: discovered.contractSymbol,
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
     * Flush discovered metadata immediately after initialization so the
     * database does not remain on an expired/old contract until the first tick.
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
      { flushIntervalMs: this.flushIntervalMs },
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

    if (!group) return;

    const tsMs = tick.exchangeTs ?? tick.receivedTs;
    const key = sessionKeyFor(tsMs);
    const ts = toIso(tsMs);

    let state = this.sessions.get(group);

    const contract = parseContract(tick.symbol);

    if (!state) {
      state = {
        group,
        sessionKey: key,
        mcx_ltp: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        updated_at: ts,
        contract_symbol: contract?.contractSymbol ?? tick.symbol,
        contract_month: contract?.contractMonth ?? "",
        expiry_date: contract?.expiryDate ?? "",
      };

      this.sessions.set(group, state);

      logger.info(
        {
          group,
          sessionKey: key,
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
     * Every live tick carries the current contract symbol.
     * Therefore when rollover changes GOLD/SILVER contract,
     * these fields automatically change on the next tick.
     */
    if (contract) {
      if (state.contract_symbol !== contract.contractSymbol) {
        logger.info(
          {
            group,
            previousContract: state.contract_symbol,
            newContract: contract.contractSymbol,
            contractMonth: contract.contractMonth,
            expiryDate: contract.expiryDate,
          },
          "[rates] contract changed",
        );
      }

      state.contract_symbol = contract.contractSymbol;
      state.contract_month = contract.contractMonth;
      state.expiry_date = contract.expiryDate;
    }

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
      if (tick.ltp > state.high) {
        state.high = tick.ltp;

        logger.info(
          {
            group,
            sessionKey: key,
            high: state.high,
          },
          "[rates] new session high",
        );
      }

      if (tick.ltp < state.low) {
        state.low = tick.ltp;

        logger.info(
          {
            group,
            sessionKey: key,
            low: state.low,
          },
          "[rates] new session low",
        );
      }
    }

    state.mcx_ltp = tick.ltp;
    state.updated_at = ts;

    this.dirty.add(group);
  }

  async flush(): Promise<void> {
    if (this.flushing || this.dirty.size === 0) return;

    this.flushing = true;

    const groups = Array.from(this.dirty);

    this.dirty.clear();

    try {
      for (const group of groups) {
        const state = this.sessions.get(group);

        if (!state) continue;

        const { error } = await getSupabase()
          .from("rates")
          .update({
            mcx_ltp: state.mcx_ltp,
            high: state.high,
            low: state.low,
            updated_at: state.updated_at,

            // MCX contract metadata
            contract_symbol: state.contract_symbol,
            contract_month: state.contract_month,
            expiry_date: state.expiry_date,
          })
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
            },
            "[rates] update failed",
          );

          /*
           * IMPORTANT:
           * Do not lose the dirty flag when Supabase update fails.
           * Retry it on the next flush.
           */
          this.dirty.add(group);

          continue;
        }

        logger.debug(
          {
            group,
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
        err instanceof Error ? err.message : String(err);

      logger.error(
        { err: this.lastError },
        "[rates] flush failed",
      );

      /*
       * Retry all groups if the flush itself failed.
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

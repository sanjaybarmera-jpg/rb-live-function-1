import type { ContractMetadata } from "./RatesWriter.js";

/**
 * Calendar-based MCX contract resolver.
 *
 * Gold futures expire on the 5th of every even month (Feb, Apr, Jun, Aug, Oct, Dec).
 * Silver futures expire on the 5th of Mar, May, Jul, Sep and Dec.
 *
 * A contract stays active until 23:30 IST on its expiry date.
 */

export type ResolverMetal = "gold" | "silver";

/** 1-based expiry months per metal. */
const SCHEDULES: Record<ResolverMetal, number[]> = {
  gold: [2, 4, 6, 8, 10, 12],
  silver: [3, 5, 7, 9, 12],
};

const EXPIRY_DAY = 5;

/** Expiry cut-off time, IST. */
const CUTOFF_HOUR = 23;
const CUTOFF_MINUTE = 30;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_CODES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Absolute UTC epoch (ms) of the expiry cut-off (23:30 IST) for a given
 * year/month expiry date.
 */
function cutoffUtcMs(year: number, month: number): number {
  return (
    Date.UTC(year, month - 1, EXPIRY_DAY, CUTOFF_HOUR, CUTOFF_MINUTE, 0, 0) -
    IST_OFFSET_MS
  );
}

/** Current IST calendar year, used only as a search starting point. */
function istYear(now: Date): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCFullYear();
}

export function resolveActiveContract(
  metal: ResolverMetal,
  now: Date = new Date(),
): ContractMetadata {
  const months = SCHEDULES[metal];
  if (!months || months.length === 0) {
    throw new Error(`[rollover] no MCX schedule configured for "${metal}"`);
  }

  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("[rollover] invalid reference date");
  }

  const startYear = istYear(now) - 1;

  let year = 0;
  let month = 0;
  let found = false;

  // Scan forward a few years; guaranteed to hit within the first ~2.
  outer: for (let y = startYear; y <= startYear + 4; y += 1) {
    for (const m of months) {
      if (cutoffUtcMs(y, m) > nowMs) {
        year = y;
        month = m;
        found = true;
        break outer;
      }
    }
  }

  if (!found) {
    throw new Error(
      `[rollover] unable to resolve an active ${metal} contract from calendar`,
    );
  }

  const expiryDate = `${year}-${pad2(month)}-${pad2(EXPIRY_DAY)}`;
  if (!ISO_DATE_RE.test(expiryDate)) {
    throw new Error(`[rollover] produced invalid expiry date "${expiryDate}"`);
  }

  const monthName = MONTH_NAMES[month - 1] as string;
  const monthCode = MONTH_CODES[month - 1] as string;
  const yy = pad2(year % 100);

  return {
    group: metal,
    token: metal === "gold" ? "mcx_gold_active" : "mcx_silver_active",
    contractSymbol: `${metal.toUpperCase()}${pad2(EXPIRY_DAY)}${monthCode}${yy}FUT`,
    contractMonth: `${monthName} ${year}`,
    expiryDate,
  };
}

export function resolveAllActiveContracts(now?: Date): ContractMetadata[] {
  return [
    resolveActiveContract("gold", now ?? new Date()),
    resolveActiveContract("silver", now ?? new Date()),
  ];
}

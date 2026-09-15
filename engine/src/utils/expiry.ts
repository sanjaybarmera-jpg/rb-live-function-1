/**
 * Expiry date normalization helpers.
 *
 * Single source of truth for converting ScripMaster / Angel One
 * expiry representations into a strict ISO `YYYY-MM-DD` string.
 *
 * Rules:
 * - NEVER concatenate raw ScripMaster text into the result.
 * - Components (day / month / year) are parsed separately,
 *   validated as numbers, and a real Date is constructed.
 * - Anything that cannot be normalized returns "" so callers
 *   can refuse the write instead of persisting garbage.
 */

const MONTH_NUMBERS: Record<string, string> = {
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

const MONTH_NAMES: Record<string, string> = {
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build an ISO date from separately validated components.
 * Returns "" when the components do not form a real calendar date.
 */
function toIsoDate(
  day: number,
  month: number,
  year: number,
): string {
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year)
  ) {
    return "";
  }

  if (year < 2000 || year > 2100) return "";
  if (month < 1 || month > 12) return "";
  if (day < 1 || day > 31) return "";

  // Validate against the real calendar (e.g. rejects 31FEB2026).
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "";
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Normalize a ScripMaster expiry such as "05OCT2026" into "2026-10-05".
 *
 * Already-normalized ISO input ("2026-10-05") is returned unchanged.
 * Anything else returns "".
 */
export function normalizeExpiryDate(expiry: string): string {
  const normalized = String(expiry ?? "").trim().toUpperCase();

  if (ISO_DATE_RE.test(normalized)) {
    return normalized;
  }

  const match = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/.exec(
    normalized,
  );

  if (!match) return "";

  const dayStr = match[1];
  const mon = match[2];
  const yearStr = match[3];
  if (!dayStr || !mon || !yearStr) return "";

  const monthNumber = MONTH_NUMBERS[mon];
  if (!monthNumber) return "";

  return toIsoDate(
    Number(dayStr),
    Number(monthNumber),
    Number(yearStr),
  );
}

/**
 * Parse the expiry embedded in a contract symbol such as
 * "GOLD05OCT26FUT" or "SILVER04DEC26FUT" into an ISO date.
 *
 * Two-digit years are interpreted as 20YY (MCX futures window).
 */
export function expiryFromContractSymbol(symbol: string): string {
  const normalized = String(symbol ?? "").trim().toUpperCase();

  const match = /(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})FUT$/.exec(
    normalized,
  );

  if (!match) return "";

  const dayStr = match[1];
  const mon = match[2];
  const yearStr = match[3];
  if (!dayStr || !mon || !yearStr) return "";

  const monthNumber = MONTH_NUMBERS[mon];
  if (!monthNumber) return "";

  return toIsoDate(
    Number(dayStr),
    Number(monthNumber),
    2000 + Number(yearStr),
  );
}

/**
 * Last-resort normalizer for values coming from the database.
 *
 * A previous engine version could persist a corrupted expiry
 * (raw ScripMaster text concatenated onto an ISO prefix).
 * This helper never trusts such a value: it accepts strict ISO,
 * otherwise re-parses from the contract symbol, otherwise "".
 */
export function sanitizeExpiryDate(
  expiryDate: string,
  contractSymbol: string,
): string {
  const normalized = String(expiryDate ?? "").trim();

  if (ISO_DATE_RE.test(normalized)) {
    return normalized;
  }

  return expiryFromContractSymbol(contractSymbol);
}

/**
 * Convert a ScripMaster expiry (e.g. "05OCT2026") into "October 2026".
 */
export function buildContractMonth(expiry: string): string {
  const normalized = String(expiry ?? "").trim().toUpperCase();
  const match = /^(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{4})$/.exec(
    normalized,
  );

  if (!match) return "";

  const mon = match[2];
  const year = match[3];
  if (!mon || !year) return "";

  const monthName = MONTH_NAMES[mon];
  if (!monthName) return "";

  return `${monthName} ${year}`;
}

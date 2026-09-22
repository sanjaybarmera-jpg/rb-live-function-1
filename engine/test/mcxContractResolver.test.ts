import { describe, expect, it } from "vitest";
import {
  resolveActiveContract,
  resolveAllActiveContracts,
} from "../src/services/McxContractResolver.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Build a UTC Date from an IST wall-clock time. */
function ist(
  y: number,
  m: number,
  d: number,
  hh = 0,
  mm = 0,
): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 60 * 60 * 1000);
}

describe("McxContractResolver", () => {
  it("keeps the current contract before the 23:30 IST cut-off", () => {
    const c = resolveActiveContract("gold", ist(2026, 10, 5, 23, 29));
    expect(c.expiryDate).toBe("2026-10-05");
    expect(c.contractSymbol).toBe("GOLD05OCT26FUT");
    expect(c.contractMonth).toBe("October 2026");
    expect(c.token).toBe("mcx_gold_active");
  });

  it("rolls to the next contract after the cut-off", () => {
    const c = resolveActiveContract("gold", ist(2026, 10, 5, 23, 31));
    expect(c.expiryDate).toBe("2026-12-05");
    expect(c.contractSymbol).toBe("GOLD05DEC26FUT");
    expect(c.contractMonth).toBe("December 2026");
  });

  it("rolls silver across the year boundary", () => {
    const c = resolveActiveContract("silver", ist(2026, 12, 6, 10, 0));
    expect(c.expiryDate).toBe("2027-03-05");
    expect(c.contractSymbol).toBe("SILVER05MAR27FUT");
    expect(c.contractMonth).toBe("March 2027");
    expect(c.token).toBe("mcx_silver_active");
  });

  it("picks the nearest silver cycle mid-year", () => {
    const c = resolveActiveContract("silver", ist(2026, 6, 20));
    expect(c.expiryDate).toBe("2026-07-05");
    expect(c.contractSymbol).toBe("SILVER05JUL26FUT");
  });

  it("returns both metals with strict ISO expiry dates", () => {
    const all = resolveAllActiveContracts(ist(2026, 1, 15));
    expect(all).toHaveLength(2);
    expect(all[0]!.group).toBe("gold");
    expect(all[1]!.group).toBe("silver");
    for (const c of all) {
      expect(c.expiryDate).toMatch(ISO);
      expect(c.contractSymbol.length).toBeGreaterThan(0);
      expect(c.contractMonth).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    }
  });

  it("always resolves a future contract for arbitrary dates", () => {
    for (let m = 1; m <= 12; m += 1) {
      for (const metal of ["gold", "silver"] as const) {
        const c = resolveActiveContract(metal, ist(2026, m, 5, 23, 45));
        expect(c.expiryDate).toMatch(ISO);
        expect(new Date(c.expiryDate).getTime()).toBeGreaterThan(
          ist(2026, m, 5).getTime() - 24 * 60 * 60 * 1000,
        );
      }
    }
  });
});

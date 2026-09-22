import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveActiveContract,
  resolveAllActiveContracts,
} from "../src/services/McxContractResolver.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Build a UTC Date from an IST wall-clock time. */
function ist(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 60 * 60 * 1000);
}

test("keeps the current contract before the 23:30 IST cut-off", () => {
  const c = resolveActiveContract("gold", ist(2026, 10, 5, 23, 29));
  assert.equal(c.expiryDate, "2026-10-05");
  assert.equal(c.contractSymbol, "GOLD05OCT26FUT");
  assert.equal(c.contractMonth, "October 2026");
  assert.equal(c.token, "mcx_gold_active");
  assert.equal(c.group, "gold");
});

test("rolls to the next contract after the cut-off", () => {
  const c = resolveActiveContract("gold", ist(2026, 10, 5, 23, 31));
  assert.equal(c.expiryDate, "2026-12-05");
  assert.equal(c.contractSymbol, "GOLD05DEC26FUT");
  assert.equal(c.contractMonth, "December 2026");
});

test("rolls silver across the year boundary", () => {
  const c = resolveActiveContract("silver", ist(2026, 12, 6, 10, 0));
  assert.equal(c.expiryDate, "2027-03-05");
  assert.equal(c.contractSymbol, "SILVER05MAR27FUT");
  assert.equal(c.contractMonth, "March 2027");
  assert.equal(c.token, "mcx_silver_active");
});

test("picks the nearest silver cycle mid-year", () => {
  const c = resolveActiveContract("silver", ist(2026, 6, 20));
  assert.equal(c.expiryDate, "2026-07-05");
  assert.equal(c.contractSymbol, "SILVER05JUL26FUT");
});

test("returns both metals with strict ISO expiry dates", () => {
  const all = resolveAllActiveContracts(ist(2026, 1, 15));
  assert.equal(all.length, 2);
  assert.equal(all[0]!.group, "gold");
  assert.equal(all[1]!.group, "silver");
  for (const c of all) {
    assert.match(c.expiryDate, ISO);
    assert.match(c.contractMonth, /^[A-Z][a-z]+ \d{4}$/);
    assert.ok(c.contractSymbol.length > 0);
  }
});

test("always resolves a future contract for arbitrary dates", () => {
  for (let m = 1; m <= 12; m += 1) {
    for (const metal of ["gold", "silver"] as const) {
      const at = ist(2026, m, 5, 23, 45);
      const c = resolveActiveContract(metal, at);
      assert.match(c.expiryDate, ISO);
      const cutoff = new Date(
        Date.UTC(
          Number(c.expiryDate.slice(0, 4)),
          Number(c.expiryDate.slice(5, 7)) - 1,
          5,
          23,
          30,
        ) - 5.5 * 60 * 60 * 1000,
      );
      assert.ok(cutoff.getTime() > at.getTime());
    }
  }
});

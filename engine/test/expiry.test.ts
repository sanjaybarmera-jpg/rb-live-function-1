import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildContractMonth,
  expiryFromContractSymbol,
  normalizeExpiryDate,
  sanitizeExpiryDate,
} from "../src/utils/expiry.js";

test("normalizes ScripMaster expiry to ISO", () => {
  assert.equal(normalizeExpiryDate("05OCT2026"), "2026-10-05");
  assert.equal(normalizeExpiryDate("04DEC2026"), "2026-12-04");
});

test("accepts already-normalized ISO input", () => {
  assert.equal(normalizeExpiryDate("2026-10-05"), "2026-10-05");
});

test("rejects garbage instead of concatenating it", () => {
  assert.equal(normalizeExpiryDate("2026-10-05OCT2026,05,OCT,2026"), "");
  assert.equal(normalizeExpiryDate(""), "");
  assert.equal(normalizeExpiryDate("OCT2026"), "");
});

test("rejects impossible calendar dates", () => {
  assert.equal(normalizeExpiryDate("31FEB2026"), "");
});

test("parses expiry from contract symbol (phase requirement)", () => {
  assert.equal(
    expiryFromContractSymbol("GOLD05OCT26FUT"),
    "2026-10-05",
  );
  assert.equal(
    expiryFromContractSymbol("SILVER04DEC26FUT"),
    "2026-12-04",
  );
});

test("sanitizes corrupted DB values using the contract symbol", () => {
  assert.equal(
    sanitizeExpiryDate(
      "2026-10-05OCT2026,05,OCT,2026",
      "GOLD05OCT26FUT",
    ),
    "2026-10-05",
  );
  assert.equal(
    sanitizeExpiryDate(
      "2026-12-04DEC2026,04,DEC,2026",
      "SILVER04DEC26FUT",
    ),
    "2026-12-04",
  );
  // Valid ISO values pass through untouched.
  assert.equal(
    sanitizeExpiryDate("2026-10-05", "GOLD05OCT26FUT"),
    "2026-10-05",
  );
  // No recoverable source → empty string, never garbage.
  assert.equal(sanitizeExpiryDate("garbage", ""), "");
});

test("buildContractMonth still produces human month", () => {
  assert.equal(buildContractMonth("05OCT2026"), "October 2026");
  assert.equal(buildContractMonth("04DEC2026"), "December 2026");
});

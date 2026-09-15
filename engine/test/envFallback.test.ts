import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEnvFallback } from "../src/providers/angelone/instruments.js";

test("parses valid ANGEL_INSTRUMENTS + METAL_TOKEN_MAP", () => {
  const r = buildEnvFallback(
    "5:466583,5:471725",
    "466583:gold,471725:silver",
  );

  assert.equal(r.instruments.length, 2);
  assert.deepEqual(r.instruments[0], { exchangeType: 5, token: "466583" });
  assert.equal(r.goldToken, "466583");
  assert.equal(r.silverToken, "471725");
  assert.equal(r.issues.length, 0);
});

test("accepts bare numeric Angel tokens", () => {
  const r = buildEnvFallback("466583", "466583:gold");
  assert.deepEqual(r.instruments, [{ exchangeType: 5, token: "466583" }]);
  assert.equal(r.goldToken, "466583");
});

test("normalizes whitespace and casing", () => {
  const r = buildEnvFallback(
    "  5 : 466583 ,  5:471725  ",
    " 466583 : GOLD , 471725 : Silver ",
  );
  assert.equal(r.instruments.length, 2);
  assert.equal(r.mappings["466583"], "gold");
  assert.equal(r.mappings["471725"], "silver");
  assert.equal(r.issues.length, 0);
});

test("rejects malformed entries without crashing", () => {
  const r = buildEnvFallback("5:,:,abc:", "466583:platinum,:gold,471725:silver");
  assert.ok(r.issues.length >= 3);
  assert.equal(r.goldToken, null);
  assert.equal(r.silverToken, "471725");
});

test("resolves instruments from METAL_TOKEN_MAP alone (ScripMaster outage)", () => {
  const r = buildEnvFallback("", "466583:gold,471725:silver");
  assert.equal(r.instruments.length, 2);
  assert.ok(r.instruments.every((i) => i.exchangeType === 5));
  assert.equal(r.goldToken, "466583");
  assert.equal(r.silverToken, "471725");
});

test("valid ENV never resolves to zero instruments", () => {
  const r = buildEnvFallback("5:466583,5:471725", "466583:gold,471725:silver");
  assert.notEqual(r.instruments.length, 0);
  const tokens = r.instruments.map((i) => i.token);
  assert.ok(tokens.includes("466583"));
  assert.ok(tokens.includes("471725"));
});

test("does not duplicate tokens listed in both variables", () => {
  const r = buildEnvFallback("5:466583", "466583:gold");
  assert.equal(r.instruments.length, 1);
});

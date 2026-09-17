import { test } from "node:test";
import assert from "node:assert/strict";

process.env["SUPABASE_URL"] ??= "https://example.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test";

const { resolvePath, toNumber } = await import(
  "../src/providers/genericapi/path.js"
);
const { parseRates, ParseError } = await import(
  "../src/providers/genericapi/parser.js"
);
import type { ParserConfig } from "../src/providers/genericapi/types.js";

test("path resolver supports array index and nesting", () => {
  const body = { data: [{ bid: 1 }, { bid: 2 }], result: { gold: { price: 9 } } };
  assert.equal(resolvePath(body, "data[1].bid"), 2);
  assert.equal(resolvePath(body, "result.gold.price"), 9);
  assert.equal(resolvePath(body, "missing.path"), undefined);
});

test("numeric coercion handles strings with separators", () => {
  assert.equal(toNumber("151,156"), 151156);
  assert.equal(toNumber(151156), 151156);
  assert.equal(toNumber("abc"), null);
  assert.equal(toNumber(null), null);
});

test("symbol-based lookup (array response)", () => {
  const cfg: ParserConfig = {
    symbolField: "symbol",
    gold: { symbol: "India Gold", bidPath: "bid", askPath: "ask" },
    silver: { symbol: "India Silver", bidPath: "bid", askPath: "ask" },
  };

  const body = {
    data: [
      { symbol: "India Gold", bid: "151156", ask: "151200" },
      { symbol: "India Silver", bid: "232617", ask: "232700" },
    ],
  };

  const rates = parseRates(body, cfg);
  assert.equal(rates.gold.bid, 151156);
  assert.equal(rates.gold.ask, 151200);
  assert.equal(rates.silver.bid, 232617);
});

test("index-based paths (no symbol field)", () => {
  const cfg: ParserConfig = {
    symbolField: "symbol",
    gold: { bidPath: "data[0].bid" },
    silver: { bidPath: "data[1].bid" },
  };
  const body = { data: [{ bid: 100 }, { bid: 200 }] };
  const rates = parseRates(body, cfg);
  assert.equal(rates.gold.bid, 100);
  assert.equal(rates.silver.bid, 200);
});

test("object-keyed response", () => {
  const cfg: ParserConfig = {
    symbolField: "symbol",
    gold: { bidPath: "gold.bid", askPath: "gold.ask" },
    silver: { bidPath: "silver.bid", askPath: "silver.ask" },
  };
  const body = {
    gold: { bid: 151156, ask: 151200 },
    silver: { bid: 232617, ask: 232700 },
  };
  const rates = parseRates(body, cfg);
  assert.equal(rates.gold.bid, 151156);
  assert.equal(rates.silver.ask, 232700);
});

test("nested single-price response", () => {
  const cfg: ParserConfig = {
    symbolField: "symbol",
    gold: { pricePath: "result.gold.price" },
    silver: { pricePath: "result.silver.price" },
  };
  const body = { result: { gold: { price: 151156 }, silver: { price: 232617 } } };
  const rates = parseRates(body, cfg);
  assert.equal(rates.gold.bid, 151156);
  assert.equal(rates.silver.bid, 232617);
});

test("zero / missing / non-numeric values are rejected", () => {
  const cfg: ParserConfig = {
    symbolField: "symbol",
    gold: { bidPath: "gold.bid" },
    silver: { bidPath: "silver.bid" },
  };

  assert.throws(
    () => parseRates({ gold: { bid: 0 }, silver: { bid: 1 } }, cfg),
    ParseError,
  );
  assert.throws(() => parseRates({ gold: {}, silver: { bid: 1 } }, cfg), ParseError);
  assert.throws(
    () => parseRates({ gold: { bid: "n/a" }, silver: { bid: 1 } }, cfg),
    ParseError,
  );
});

test("timestamp parsing supports epoch seconds and ISO strings", () => {
  const cfg: ParserConfig = {
    symbolField: "symbol",
    timestampPath: "ts",
    gold: { bidPath: "gold.bid" },
    silver: { bidPath: "silver.bid" },
  };

  const epoch = parseRates(
    { ts: 1700000000, gold: { bid: 1 }, silver: { bid: 2 } },
    cfg,
  );
  assert.equal(epoch.timestamp, new Date(1700000000000).toISOString());

  const iso = parseRates(
    { ts: "2026-09-17T06:00:00.000Z", gold: { bid: 1 }, silver: { bid: 2 } },
    cfg,
  );
  assert.equal(iso.timestamp, "2026-09-17T06:00:00.000Z");
});

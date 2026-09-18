import { test } from "node:test";
import assert from "node:assert/strict";

process.env["SUPABASE_URL"] ??= "https://example.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test";

const { parseRates, ParseError } = await import(
  "../src/providers/genericapi/parser.js"
);
const { buildInstrumentMapping } = await import(
  "../src/providers/genericapi/config.js"
);
import type { ParserConfig } from "../src/providers/genericapi/types.js";

const body = {
  data: [
    { id: "1", symbol: "Gold Future", ltp: "151156", high: "151315", low: "150483" },
    { id: "2", symbol: "Silver Future", ltp: "232617", high: "233097", low: "230221" },
    { id: "3", symbol: "USDINR", ltp: "88.42", high: "88.60", low: "88.10" },
    { id: "4", symbol: "USD Gold", ltp: "4120.5", high: "4130", low: "4100" },
    { id: "5", symbol: "USD Silver", ltp: "52.3", high: "53", low: "51.2" },
  ],
};

const fiveSource: ParserConfig = {
  itemsPath: "data",
  idField: "id",
  symbolField: "symbol",
  gold: { id: "1", pricePath: "ltp", highPath: "high", lowPath: "low" },
  silver: { id: "2", pricePath: "ltp", highPath: "high", lowPath: "low" },
  usd_inr: { id: "3", pricePath: "ltp", highPath: "high", lowPath: "low" },
  usd_gold: { id: "4", pricePath: "ltp", highPath: "high", lowPath: "low" },
  usd_silver: { id: "5", pricePath: "ltp", highPath: "high", lowPath: "low" },
};

test("all five sources map by id with ltp/high/low", () => {
  const rates = parseRates(body, fiveSource);

  assert.equal(rates.instruments.gold?.ltp, 151156);
  assert.equal(rates.instruments.gold?.high, 151315);
  assert.equal(rates.instruments.gold?.low, 150483);
  assert.equal(rates.instruments.silver?.ltp, 232617);
  assert.equal(rates.instruments.usd_inr?.ltp, 88.42);
  assert.equal(rates.instruments.usd_gold?.ltp, 4120.5);
  assert.equal(rates.instruments.usd_silver?.low, 51.2);
  assert.deepEqual(rates.errors, {});
  assert.equal(rates.instruments.gold?.matchedBy, "id");
});

test("symbol fallback works when no id is configured", () => {
  const cfg: ParserConfig = {
    itemsPath: "data",
    symbolField: "symbol",
    gold: { symbol: "Gold Future", pricePath: "ltp" },
    silver: { symbol: "Silver Future", pricePath: "ltp" },
  };
  const rates = parseRates(body, cfg);
  assert.equal(rates.gold.ltp, 151156);
  assert.equal(rates.gold.matchedBy, "symbol");
  assert.equal(rates.silver.ltp, 232617);
});

test("id + symbol mismatch never selects the wrong instrument", () => {
  const cfg: ParserConfig = {
    itemsPath: "data",
    idField: "id",
    symbolField: "symbol",
    gold: { id: "1", symbol: "Silver Future", pricePath: "ltp" },
    silver: { id: "2", pricePath: "ltp" },
  };
  assert.throws(() => parseRates(body, cfg), ParseError);
});

test("unknown id is reported as a mapping failure", () => {
  const cfg: ParserConfig = {
    ...fiveSource,
    usd_inr: { id: "99", pricePath: "ltp" },
  };
  const rates = parseRates(body, cfg);
  assert.equal(rates.instruments.usd_inr, undefined);
  assert.match(String(rates.errors.usd_inr), /not found/);
});

test("missing or invalid numeric ltp is rejected", () => {
  const bad = { data: [{ id: "1", symbol: "Gold Future", ltp: "n/a" }] };
  const cfg: ParserConfig = {
    itemsPath: "data",
    idField: "id",
    symbolField: "symbol",
    gold: { id: "1", pricePath: "ltp" },
    silver: { id: "1", pricePath: "ltp" },
  };
  assert.throws(() => parseRates(bad, cfg), ParseError);

  const zero = { data: [{ id: "1", symbol: "Gold Future", ltp: 0 }] };
  assert.throws(() => parseRates(zero, cfg), ParseError);
});

test("backward compatible bid/ask gold+silver configuration still works", () => {
  const cfg: ParserConfig = {
    itemsPath: "data",
    symbolField: "symbol",
    gold: { symbol: "India Gold", bidPath: "bid", askPath: "ask" },
    silver: { symbol: "India Silver", bidPath: "bid", askPath: "ask" },
  };
  const legacyBody = {
    data: [
      { symbol: "India Gold", bid: "151156", ask: "151200" },
      { symbol: "India Silver", bid: "232617", ask: "232700" },
    ],
  };
  const rates = parseRates(legacyBody, cfg);
  assert.equal(rates.gold.ltp, 151156);
  assert.equal(rates.gold.bid, 151156);
  assert.equal(rates.gold.ask, 151200);
  assert.equal(rates.silver.ltp, 232617);
});

test("V5 response: id-only mappings fall back to shared bid/ask/high/low fields", () => {
  const v5 = {
    data: [
      { id: "3722", symbol: "Gold Future", bid: "151156", ask: "151200", high: "151315", low: "150483" },
      { id: "3723", symbol: "Silver Future", bid: "232617", ask: "232700", high: "233097", low: "230221" },
      { id: "3721", symbol: "USDINR", bid: "88.42", ask: "88.44", high: "88.60", low: "88.10" },
      { id: "3719", symbol: "USD Gold", bid: "4120.5", ask: "4121", high: "4130", low: "4100" },
      { id: "3720", symbol: "USD Silver", bid: "52.3", ask: "52.4", high: "53", low: "51.2" },
    ],
  };
  const cfg: ParserConfig = {
    itemsPath: "data",
    idField: "id",
    symbolField: "symbol",
    gold: { id: "3722" },
    silver: { id: "3723" },
    usd_inr: { id: "3721" },
    usd_gold: { id: "3719" },
    usd_silver: { id: "3720" },
  };
  const rates = parseRates(v5, cfg);

  assert.equal(rates.instruments.gold?.ltp, 151156);
  assert.equal(rates.instruments.gold?.high, 151315);
  assert.equal(rates.instruments.gold?.low, 150483);
  assert.equal(rates.instruments.gold?.ask, 151200);
  assert.equal(rates.instruments.gold?.matchedBy, "id");
  assert.equal(rates.instruments.silver?.ltp, 232617);
  assert.equal(rates.instruments.silver?.high, 233097);
  assert.equal(rates.instruments.usd_inr?.ltp, 88.42);
  assert.equal(rates.instruments.usd_inr?.low, 88.1);
  assert.equal(rates.instruments.usd_gold?.ltp, 4120.5);
  assert.equal(rates.instruments.usd_gold?.high, 4130);
  assert.equal(rates.instruments.usd_silver?.ltp, 52.3);
  assert.equal(rates.instruments.usd_silver?.low, 51.2);
  assert.deepEqual(rates.errors, {});
});

test("explicit PRICE_PATH still wins over the shared bid/ask fallback", () => {
  const v5 = {
    data: [
      { id: "3722", symbol: "Gold Future", bid: "100", ask: "101", high: "110", low: "90", ltp: "105" },
      { id: "3723", symbol: "Silver Future", bid: "200", ask: "201", high: "210", low: "190" },
    ],
  };
  const cfg: ParserConfig = {
    itemsPath: "data",
    idField: "id",
    symbolField: "symbol",
    gold: { id: "3722", pricePath: "ltp", highPath: "high", lowPath: "low" },
    silver: { id: "3723" },
  };
  const rates = parseRates(v5, cfg);
  assert.equal(rates.gold.ltp, 105);
  assert.equal(rates.silver.ltp, 200);
});

test("instrument mapping is built from ENV prefixes", () => {
  const mapping = buildInstrumentMapping(
    {
      USD_INR_ID: " 3 ",
      USD_INR_SYMBOL: "USDINR",
      USD_INR_PRICE_PATH: "ltp",
      USD_INR_HIGH_PATH: "",
    },
    "USD_INR",
  );
  assert.deepEqual(mapping, {
    id: "3",
    symbol: "USDINR",
    pricePath: "ltp",
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";

process.env["SUPABASE_URL"] ??= "https://example.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test";
process.env["ANGEL_API_KEY"] ??= "test";
process.env["ANGEL_CLIENT_CODE"] ??= "test";
process.env["ANGEL_PIN"] ??= "1234";
process.env["ANGEL_TOTP_SECRET"] ??= "test";

const { SpotRatesWriter } = await import("../src/services/SpotRatesWriter.js");
import type { SpotSnapshot } from "../src/services/MetalPriceService.js";

interface Call {
  table: string;
  payload: Record<string, unknown>;
  column: string;
  value: string;
}

function makeDb(affected: (id: string) => number) {
  const calls: Call[] = [];
  const db = () => ({
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            eq(column: string, value: string) {
              calls.push({ table, payload, column, value });
              return {
                select() {
                  const rows = Array.from({ length: affected(value) }, () => ({
                    id: value,
                  }));
                  return Promise.resolve({ data: rows, error: null });
                },
              };
            },
          };
        },
      };
    },
  });
  return { db, calls };
}

function snap(overrides: Partial<SpotSnapshot> = {}): SpotSnapshot {
  const now = new Date().toISOString();
  return {
    goldUsdPerOz: 2400,
    silverUsdPerOz: 30,
    usdInr: 83.5,
    goldInrPerGram: 1,
    silverInrPerGram: 1,
    providerTimestamp: now,
    fetchedAt: now,
    ...overrides,
  };
}

test("updates exactly the three existing usd rows by id", async () => {
  const { db, calls } = makeDb(() => 1);
  const writer = new SpotRatesWriter(db);

  await writer.write(snap());

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.value),
    ["usd_gold", "usd_silver", "usd_inr"],
  );
  for (const c of calls) {
    assert.equal(c.table, "rates");
    assert.equal(c.column, "id");
    const keys = Object.keys(c.payload).sort();
    assert.deepEqual(keys, [
      "buy_price",
      "high",
      "low",
      "mcx_ltp",
      "sell_price",
      "updated_at",
    ]);
  }

  const gold = calls[0]!.payload;
  assert.equal(gold["mcx_ltp"], 2400);
  assert.equal(gold["buy_price"], 2400);
  assert.equal(gold["sell_price"], 2400);
  assert.equal(calls[1]!.payload["mcx_ltp"], 30);
  assert.equal(calls[2]!.payload["mcx_ltp"], 83.5);
});

test("zero affected rows is a failure and never inserts", async () => {
  const { db, calls } = makeDb(() => 0);
  const writer = new SpotRatesWriter(db);

  await writer.write(snap());

  assert.equal(calls.length, 3);
  for (const d of writer.snapshot()) {
    assert.equal(d.failures, 1);
    assert.equal(d.updates, 0);
    assert.equal(d.lastError, "row not found");
  }
});

test("invalid / zero values are skipped", async () => {
  const { db, calls } = makeDb(() => 1);
  const writer = new SpotRatesWriter(db);

  await writer.write(snap({ silverUsdPerOz: 0, usdInr: Number.NaN }));

  assert.deepEqual(
    calls.map((c) => c.value),
    ["usd_gold"],
  );
});

// TEST A: Successful fetch + old providerTimestamp => database update MUST happen
test("successful fetch with old providerTimestamp still updates (A)", async () => {
  const { db, calls } = makeDb(() => 1);
  const writer = new SpotRatesWriter(db, 30 * 60 * 1000);

  const now = new Date();
  const oldProviderTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour old

  await writer.write(
    snap({
      providerTimestamp: oldProviderTime.toISOString(),
      fetchedAt: now.toISOString(),
    }),
  );

  // Should perform 3 updates (not skip) because fetchedAt is fresh
  assert.equal(calls.length, 3);
  for (const d of writer.snapshot()) {
    assert.equal(d.updates, 1);
    assert.equal(d.failures, 0);
    assert.equal(d.skipped, 0);
  }
});

// TEST B: Successful fetch + current providerTimestamp => database update MUST happen
test("successful fetch with current providerTimestamp updates (B)", async () => {
  const { db, calls } = makeDb(() => 1);
  const writer = new SpotRatesWriter(db, 30 * 60 * 1000);

  const now = new Date().toISOString();

  await writer.write(
    snap({
      providerTimestamp: now,
      fetchedAt: now,
    }),
  );

  // Should perform 3 updates
  assert.equal(calls.length, 3);
  for (const d of writer.snapshot()) {
    assert.equal(d.updates, 1);
  }
});

// TEST C: Invalid/zero/negative/NaN values => database update MUST NOT happen
test("invalid values prevent update (C)", async () => {
  const { db, calls } = makeDb(() => 1);
  const writer = new SpotRatesWriter(db);

  await writer.write(snap({ goldUsdPerOz: -100, silverUsdPerOz: 0, usdInr: Number.NaN }));

  // No updates should occur
  assert.equal(calls.length, 0);
  for (const d of writer.snapshot()) {
    assert.equal(d.updates, 0);
    assert.equal(d.skipped, 3);
  }
});

// TEST D: API/network failure (missing row) => database update MUST NOT happen
test("API/network failure (missing row) => no update (D)", async () => {
  const { db, calls } = makeDb(() => 0);
  const writer = new SpotRatesWriter(db);

  await writer.write(snap());

  // All 3 rows attempt update but fail (affected = 0)
  assert.equal(calls.length, 3);
  for (const d of writer.snapshot()) {
    assert.equal(d.updates, 0);
    assert.equal(d.failures, 1);
    assert.equal(d.lastError, "row not found");
  }
});

// TEST E: Missing usd_* row => log error, no insert/upsert
test("missing row logs error without insert (E)", async () => {
  const { db, calls } = makeDb(() => 0);
  const writer = new SpotRatesWriter(db);

  await writer.write(snap());

  // Verify no rows were inserted/upserted (db was only called for update/select)
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.table, "rates");
    assert.equal(call.column, "id");
  }
});

// TEST F: updated_at must equal fetchedAt, not providerTimestamp
test("updated_at equals fetchedAt, not providerTimestamp (F)", async () => {
  const { db, calls } = makeDb(() => 1);
  const writer = new SpotRatesWriter(db);

  const oldProviderTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const currentFetchedTime = new Date().toISOString();

  await writer.write(
    snap({
      providerTimestamp: oldProviderTime,
      fetchedAt: currentFetchedTime,
    }),
  );

  // All 3 rows should have updated_at = fetchedAt (currentFetchedTime)
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.payload.updated_at, currentFetchedTime);
  }
});

test("stale snapshot (old fetchedAt) updates nothing", async () => {
  const { db, calls } = makeDb(() => 1);
  const writer = new SpotRatesWriter(db, 60_000);

  await writer.write(
    snap({ fetchedAt: new Date(Date.now() - 600_000).toISOString() }),
  );

  assert.equal(calls.length, 0);
  for (const d of writer.snapshot()) {
    assert.equal(d.skipped, 1);
  }
});

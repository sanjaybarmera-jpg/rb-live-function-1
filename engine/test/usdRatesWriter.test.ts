import assert from "node:assert/strict";
import test from "node:test";

import {
  UsdRatesWriter,
  USD_ROW_IDS,
  type UsdRowId,
} from "../src/services/UsdRatesWriter.js";
import { RateBroadcaster, type CustomerRate } from "../src/services/RateBroadcaster.js";
import type { RatesDbClient } from "../src/services/RatesWriter.js";

interface Captured {
  table: string;
  payload: Record<string, unknown>;
  column: string;
  values: string[];
}

function makeDb(
  captured: Captured[],
  result: { data: { metal_type: string }[] | null; error: { message: string } | null },
): () => RatesDbClient {
  return () => ({
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            in(column: string, values: string[]) {
              return {
                select(): PromiseLike<typeof result> {
                  captured.push({ table, payload, column, values });
                  return Promise.resolve(result);
                },
              };
            },
          };
        },
      };
    },
  });
}

test("writes each USD source to its RB internal rates row", async () => {
  for (const id of USD_ROW_IDS) {
    const captured: Captured[] = [];
    const writer = new UsdRatesWriter(
      makeDb(captured, { data: [{ metal_type: id }], error: null }),
    );

    const ok = await writer.write({
      id,
      ltp: 100,
      high: 110,
      low: 90,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.equal(ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.table, "rates");
    assert.deepEqual(captured[0]!.values, [id]);
    assert.equal(captured[0]!.payload["mcx_ltp"], 100);
    assert.equal(captured[0]!.payload["high"], 110);
    assert.equal(captured[0]!.payload["low"], 90);
    assert.equal(
      captured[0]!.payload["updated_at"],
      "2026-01-01T00:00:00.000Z",
    );
    /* USD rows keep buy = sell = LTP. */
    assert.equal(captured[0]!.payload["buy_price"], 100);
    assert.equal(captured[0]!.payload["sell_price"], 100);

    const diag = writer.diagnostics()[id];
    assert.equal(diag.writes, 1);
    assert.equal(diag.affectedRows, 1);
    assert.equal(diag.lastError, null);
  }
});

test("zero affected rows is a failure, not a success", async () => {
  const captured: Captured[] = [];
  const writer = new UsdRatesWriter(makeDb(captured, { data: [], error: null }));

  const ok = await writer.write({
    id: "usd_gold",
    ltp: 2500,
    high: null,
    low: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(ok, false);
  const diag = writer.diagnostics()["usd_gold"];
  assert.equal(diag.writes, 0);
  assert.equal(diag.failures, 1);
  assert.match(String(diag.lastError), /0 rows/);
});

test("invalid values are rejected before touching Supabase", async () => {
  const captured: Captured[] = [];
  const writer = new UsdRatesWriter(
    makeDb(captured, { data: [{ metal_type: "usd_inr" }], error: null }),
  );

  assert.equal(
    await writer.write({
      id: "usd_inr",
      ltp: 0,
      high: null,
      low: null,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }),
    false,
  );
  assert.equal(captured.length, 0);
});

test("SSE payload uses the RB internal id for the USD sources", async () => {
  const broadcaster = new RateBroadcaster();
  const seen: CustomerRate[] = [];
  broadcaster.subscribe((r) => seen.push(r));

  const captured: Captured[] = [];
  const writer = new UsdRatesWriter(
    makeDb(captured, { data: [{ metal_type: "usd_silver" }], error: null }),
    broadcaster,
  );

  await writer.write({
    id: "usd_silver",
    ltp: 31.2,
    high: 32,
    low: 30,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.metal, "usd_silver");
  assert.equal(seen[0]!.ltp, 31.2);
  assert.ok(broadcaster.getSnapshot()["usd_silver" as UsdRowId]);
});

test("identical values are not re-written", async () => {
  const captured: Captured[] = [];
  const writer = new UsdRatesWriter(
    makeDb(captured, { data: [{ metal_type: "usd_inr" }], error: null }),
  );

  const input = {
    id: "usd_inr" as const,
    ltp: 88.1,
    high: 88.5,
    low: 87.9,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };

  assert.equal(await writer.write(input), true);
  assert.equal(await writer.write(input), false);
  assert.equal(captured.length, 1);
});

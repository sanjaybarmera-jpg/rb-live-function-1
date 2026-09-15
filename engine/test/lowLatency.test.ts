import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { RatesWriter, type RatesDbClient } from "../src/services/RatesWriter.js";
import { setTokenGroup } from "../src/services/metals.js";
import {
  getFeedDiagnostics,
  resetFeedDiagnostics,
} from "../src/services/feedDiagnostics.js";
import type { Tick } from "../src/models/Tick.js";

const GOLD_TOKEN = "466583";
const SILVER_TOKEN = "471725";

setTokenGroup(GOLD_TOKEN, "gold");
setTokenGroup(SILVER_TOKEN, "silver");

const CONTRACTS = [
  {
    group: "gold" as const,
    token: GOLD_TOKEN,
    contractSymbol: "GOLD05OCT26FUT",
    contractMonth: "October 2026",
    expiryDate: "2026-10-05",
  },
  {
    group: "silver" as const,
    token: SILVER_TOKEN,
    contractSymbol: "SILVER04DEC26FUT",
    contractMonth: "December 2026",
    expiryDate: "2026-12-04",
  },
];

interface WriteRecord {
  targets: string[];
  ltp: number;
  at: number;
}

/** Fake Supabase update chain with controllable latency / failure. */
class FakeDb implements RatesDbClient {
  writes: WriteRecord[] = [];
  inFlight = 0;
  maxConcurrent = 0;
  /** per metal_type delay in ms */
  delayFor: (target: string) => number = () => 0;
  failNext = new Map<string, number>();

  from(_table: string) {
    const db = this;
    return {
      update(payload: Record<string, unknown>) {
        return {
          in(_column: string, values: string[]) {
            return {
              async select(_columns: string) {
                const target = values[0] ?? "";
                db.inFlight += 1;
                db.maxConcurrent = Math.max(db.maxConcurrent, db.inFlight);
                await sleep(db.delayFor(target));
                db.inFlight -= 1;

                const remainingFailures = db.failNext.get(target) ?? 0;
                if (remainingFailures > 0) {
                  db.failNext.set(target, remainingFailures - 1);
                  return { data: null, error: { message: "boom" } };
                }

                db.writes.push({
                  targets: values,
                  ltp: Number(payload["mcx_ltp"]),
                  at: Date.now(),
                });
                return {
                  data: values.map((metal_type) => ({ metal_type })),
                  error: null,
                };
              },
            };
          },
        };
      },
    };
  }

  writesFor(metal: "gold" | "silver"): WriteRecord[] {
    return this.writes.filter((w) => w.targets[0] === metal);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tick(token: string, ltp: number): Tick {
  return {
    provider: "angelone",
    symbol: token,
    instrumentId: `5:${token}`,
    exchange: "MCX_FO",
    ltp,
    receivedTs: Date.now(),
  };
}

function writer(db: FakeDb, coalesceMs = 5): RatesWriter {
  return new RatesWriter(coalesceMs, CONTRACTS, () => db);
}

beforeEach(() => {
  resetFeedDiagnostics();
});

test("a genuine LTP change triggers a low-latency write", async () => {
  const db = new FakeDb();
  const w = writer(db);

  w.write(tick(GOLD_TOKEN, 100000));
  await sleep(40);

  assert.equal(db.writesFor("gold").length, 1);
  assert.equal(db.writesFor("gold")[0]?.ltp, 100000);
});

test("a ₹1 movement is never suppressed", async () => {
  const db = new FakeDb();
  const w = writer(db);

  w.write(tick(GOLD_TOKEN, 100000));
  await sleep(30);
  w.write(tick(GOLD_TOKEN, 100001));
  await sleep(30);

  assert.deepEqual(
    db.writesFor("gold").map((x) => x.ltp),
    [100000, 100001],
  );
});

test("duplicate LTP does not create an extra write", async () => {
  const db = new FakeDb();
  const w = writer(db);

  w.write(tick(GOLD_TOKEN, 100000));
  await sleep(30);
  w.write(tick(GOLD_TOKEN, 100000));
  w.write(tick(GOLD_TOKEN, 100000));
  await sleep(40);

  assert.equal(db.writesFor("gold").length, 1);
  assert.equal(getFeedDiagnostics().gold.duplicateLtp, 2);
  assert.equal(getFeedDiagnostics().gold.ltpChanged, 1);
});

test("latest tick is preserved while a write is in flight, with no concurrent writes", async () => {
  const db = new FakeDb();
  db.delayFor = () => 60;
  const w = writer(db);

  w.write(tick(GOLD_TOKEN, 1));
  await sleep(15);
  // These arrive while the first write is still running.
  w.write(tick(GOLD_TOKEN, 2));
  w.write(tick(GOLD_TOKEN, 3));

  await sleep(250);

  const ltps = db.writesFor("gold").map((x) => x.ltp);
  assert.equal(db.maxConcurrent <= 2, true, "at most one write per metal");
  assert.equal(ltps.length <= 2, true, "intermediate ticks coalesced");
  assert.equal(ltps.at(-1), 3, "latest LTP is never lost");
});

test("a slow Gold write does not block Silver", async () => {
  const db = new FakeDb();
  db.delayFor = (target) => (target === "gold" ? 200 : 0);
  const w = writer(db);

  w.write(tick(GOLD_TOKEN, 100000));
  w.write(tick(SILVER_TOKEN, 90000));

  await sleep(60);

  assert.equal(db.writesFor("silver").length, 1, "silver wrote while gold was busy");
  assert.equal(db.writesFor("gold").length, 0, "gold still in flight");

  await sleep(250);
  assert.equal(db.writesFor("gold").length, 1);
});

test("a failed write retries and preserves the latest value", async () => {
  const db = new FakeDb();
  db.failNext.set("gold", 1);
  const w = writer(db);

  w.write(tick(GOLD_TOKEN, 100000));
  await sleep(30);
  assert.equal(db.writesFor("gold").length, 0);
  assert.equal(getFeedDiagnostics().gold.writesFailed, 1);

  w.write(tick(GOLD_TOKEN, 100005));
  await sleep(600);

  assert.equal(db.writesFor("gold").length, 1);
  assert.equal(db.writesFor("gold")[0]?.ltp, 100005);
});

test("bursts never create unlimited concurrent writes", async () => {
  const db = new FakeDb();
  db.delayFor = () => 20;
  const w = writer(db);

  for (let i = 1; i <= 50; i++) w.write(tick(GOLD_TOKEN, 100000 + i));
  await sleep(400);

  assert.equal(db.maxConcurrent <= 2, true);
  assert.equal(db.writesFor("gold").length <= 5, true, "burst coalesced");
  assert.equal(db.writesFor("gold").at(-1)?.ltp, 100050);
});

test("diagnostics expose per-metal counters", async () => {
  const db = new FakeDb();
  const w = writer(db);

  w.write(tick(SILVER_TOKEN, 90000));
  await sleep(40);

  const d = getFeedDiagnostics().silver;
  assert.equal(d.ticksReceived, 1);
  assert.equal(d.writesStarted, 1);
  assert.equal(d.writesSucceeded, 1);
  assert.equal(d.pendingLatestTick, false);
  assert.ok(d.lastDbWriteAt);
  assert.ok(d.lastLtpChangedAt);
  assert.equal(typeof d.lastWriteLatencyMs, "number");
  assert.equal(typeof d.lastTickToWriteMs, "number");
});

test("history writes do not block tick processing", async () => {
  // Mirrors MarketEngine.drain(): history is fire-and-forget with a catch.
  let processed = 0;
  const slowHistory = {
    async write(): Promise<void> {
      await sleep(200);
      throw new Error("history down");
    },
  };

  const started = Date.now();
  for (let i = 0; i < 5; i++) {
    void slowHistory.write().catch(() => {});
    processed += 1;
  }
  const elapsed = Date.now() - started;

  assert.equal(processed, 5);
  assert.ok(elapsed < 50, "tick loop must not wait for history round-trips");
  await sleep(250);
});

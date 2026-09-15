import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { buildEnvFallback } from "../src/providers/angelone/instruments.js";
import {
  RolloverService,
  setActiveContracts,
  setEnvFallbackTokens,
  getRolloverState,
  __resetRolloverState,
} from "../src/services/rollover.js";
import type { Instrument } from "../src/providers/types.js";
import type { Tick } from "../src/models/Tick.js";

const FUTURE = "05OCT2099";

function discovered(group: "gold" | "silver", token: string, symbol: string) {
  return {
    group,
    token,
    symbol,
    expiry: FUTURE,
    expiryMs: 0,
    name: group.toUpperCase(),
    lotSize: 1,
  };
}

class FakeProvider {
  subscribed: Instrument[] = [];
  unsubscribed: Instrument[] = [];
  subscribeCalls: Instrument[][] = [];

  constructor(initial: string[] = []) {
    this.subscribed = initial.map((token) => ({ exchangeType: 5, token }));
  }
  getSubscribed(): Instrument[] {
    return [...this.subscribed];
  }
  async subscribeInstruments(add: Instrument[]): Promise<void> {
    assert.ok(add.length > 0, "must never subscribe an empty token list");
    this.subscribeCalls.push(add);
    this.subscribed.push(...add);
  }
  async unsubscribeInstruments(remove: Instrument[]): Promise<void> {
    this.unsubscribed.push(...remove);
    this.subscribed = this.subscribed.filter(
      (i) => !remove.some((r) => r.token === i.token),
    );
  }
  async waitForTick(token: string): Promise<Tick> {
    return {
      provider: "angelone",
      symbol: token,
      instrumentId: token,
      exchange: "MCX_FO",
      ltp: 100,
      receivedTs: Date.now(),
    };
  }
  getLastValidTickTs(): number | null {
    return Date.now();
  }
}

beforeEach(() => {
  __resetRolloverState();
});

/* ---------------------------------------------------------------- ENV parsing */

test("ANGEL_INSTRUMENTS in EXCHANGE:TOKEN form resolves Gold and Silver", () => {
  const r = buildEnvFallback("5:466583,5:471725", "466583:gold,471725:silver");

  assert.equal(r.rawEntryCount, 4);
  assert.equal(r.instruments.length, 2);
  assert.equal(r.goldToken, "466583");
  assert.equal(r.silverToken, "471725");
  assert.equal(r.issues.length, 0);
});

test("bare numeric Angel tokens are accepted and default to MCX", () => {
  const r = buildEnvFallback("466583,471725", "466583:gold,471725:silver");

  assert.deepEqual(r.instruments, [
    { exchangeType: 5, token: "466583" },
    { exchangeType: 5, token: "471725" },
  ]);
});

test("whitespace and casing are normalized without discarding valid tokens", () => {
  const r = buildEnvFallback(
    "  5 : 466583 , 471725 ",
    " 466583 : GOLD , 471725 : Silver ",
  );

  assert.equal(r.instruments.length, 2);
  assert.equal(r.mappings["466583"], "gold");
  assert.equal(r.mappings["471725"], "silver");
  assert.equal(r.issues.length, 0);
});

test("non-numeric tokens are rejected with an explicit reason", () => {
  const r = buildEnvFallback("5:GOLDFUT", "GOLDFUT:gold");

  assert.equal(r.instruments.length, 0);
  assert.equal(r.issues.length, 2);
  assert.ok(r.issues.every((i) => i.includes("numeric Angel token")));
});

test("unknown metal names are rejected with an explicit reason", () => {
  const r = buildEnvFallback("", "466583:platinum,471725:silver");

  assert.ok(r.issues.some((i) => i.includes("gold or silver")));
  assert.equal(r.goldToken, null);
  assert.equal(r.silverToken, "471725");
});

test("METAL_TOKEN_MAP alone is enough during a ScripMaster outage", () => {
  const r = buildEnvFallback("", "466583:gold,471725:silver");

  const tokens = r.instruments.map((i) => i.token);
  assert.notEqual(r.instruments.length, 0, "valid ENV must never yield []");
  assert.ok(tokens.includes("466583"), "gold present in subscription list");
  assert.ok(tokens.includes("471725"), "silver present in subscription list");
});

test("only invalid configuration produces an empty subscription list", () => {
  assert.equal(buildEnvFallback("", "").instruments.length, 0);
  assert.equal(buildEnvFallback("5:", ":gold").instruments.length, 0);
});

/* ------------------------------------------------- AUTO discovery + recovery */

test("AUTO discovery still subscribes both metals when no contract is active", async () => {
  const provider = new FakeProvider();
  const svc = new RolloverService({
    provider,
    enabled: true,
    intervalMs: 6 * 60 * 60 * 1000,
    recoveryIntervalMs: 60_000,
    tickConfirmTimeoutMs: 1000,
    discover: async () => ({
      instruments: [],
      contracts: [
        discovered("gold", "466583", "GOLD05OCT99FUT"),
        discovered("silver", "471725", "SILVER05OCT99FUT"),
      ],
      cacheAgeMs: null,
      discoveredAt: new Date().toISOString(),
    }),
  });

  await svc.check();

  const tokens = provider.getSubscribed().map((i) => i.token);
  assert.ok(tokens.includes("466583"));
  assert.ok(tokens.includes("471725"));
  assert.equal(getRolloverState().currentContracts.length, 2);
});

test("rollover replaces ENV fallback tokens once ScripMaster recovers", async () => {
  const provider = new FakeProvider(["999999"]);
  setActiveContracts([]);
  setEnvFallbackTokens(["999999"]);

  const svc = new RolloverService({
    provider,
    enabled: true,
    intervalMs: 60_000,
    recoveryIntervalMs: 5_000,
    tickConfirmTimeoutMs: 1000,
    discover: async () => ({
      instruments: [],
      contracts: [discovered("gold", "466583", "GOLD05OCT99FUT")],
      cacheAgeMs: null,
      discoveredAt: new Date().toISOString(),
    }),
  });

  await svc.check();

  const tokens = provider.getSubscribed().map((i) => i.token);
  assert.ok(tokens.includes("466583"), "discovered contract subscribed");
  assert.ok(!tokens.includes("999999"), "stale fallback token dropped");
});

test("discovery failure keeps the existing subscription and never empties it", async () => {
  const provider = new FakeProvider(["466583"]);
  setActiveContracts([
    { group: "gold", token: "466583", symbol: "GOLD05OCT99FUT", expiry: FUTURE },
  ]);

  const svc = new RolloverService({
    provider,
    enabled: true,
    intervalMs: 60_000,
    recoveryIntervalMs: 5_000,
    discover: async () => {
      throw new Error("ENETUNREACH");
    },
  });

  await svc.check();

  assert.deepEqual(
    provider.getSubscribed().map((i) => i.token),
    ["466583"],
  );
  assert.equal(getRolloverState().lastRolloverStatus, "failed");
});

test("recovery pace is used while no contract is active, normal pace afterwards", async () => {
  const provider = new FakeProvider();
  const svc = new RolloverService({
    provider,
    enabled: true,
    intervalMs: 6 * 60 * 60 * 1000,
    recoveryIntervalMs: 60_000,
    tickConfirmTimeoutMs: 1000,
    discover: async () => ({
      instruments: [],
      contracts: [discovered("gold", "466583", "GOLD05OCT99FUT")],
      cacheAgeMs: null,
      discoveredAt: new Date().toISOString(),
    }),
  });

  // No contracts yet -> recovery interval drives the next check.
  svc.start(false);
  const recoveryNext = Date.parse(getRolloverState().nextCheckTime ?? "");
  assert.ok(recoveryNext - Date.now() <= 60_000 + 500);

  await svc.check();
  svc.stop();
  svc.start(false);

  const normalNext = Date.parse(getRolloverState().nextCheckTime ?? "");
  assert.ok(
    normalNext - Date.now() > 60_000 * 10,
    "normal interval resumes once a contract is active",
  );
  svc.stop();
});

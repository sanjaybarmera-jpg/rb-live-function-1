import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { validateContract } from "../src/providers/angelone/instruments.js";
import {
  RolloverService,
  setActiveContracts,
  setEnvFallbackTokens,
  getEnvFallbackTokens,
  getRolloverState,
  __resetRolloverState,
} from "../src/services/rollover.js";
import type { Instrument } from "../src/providers/types.js";
import type { Tick } from "../src/models/Tick.js";

const FUTURE = "05OCT2099";
const PAST = "05OCT2020";

function contract(group: "gold" | "silver", token: string, symbol: string, expiry = FUTURE) {
  return { group, token, symbol, expiry, expiryMs: 0, name: group.toUpperCase(), lotSize: 1 };
}

class FakeProvider {
  subscribed: Instrument[] = [];
  unsubscribed: Instrument[] = [];
  constructor(initial: string[] = []) {
    this.subscribed = initial.map((token) => ({ exchangeType: 5, token }));
  }
  getSubscribed(): Instrument[] {
    return [...this.subscribed];
  }
  async subscribeInstruments(add: Instrument[]): Promise<void> {
    assert.ok(add.length > 0, "must never subscribe an empty token list");
    this.subscribed.push(...add);
  }
  async unsubscribeInstruments(remove: Instrument[]): Promise<void> {
    this.unsubscribed.push(...remove);
    this.subscribed = this.subscribed.filter((i) => !remove.some((r) => r.token === i.token));
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

function service(provider: FakeProvider, discover: () => Promise<any>, onChanged?: (c: any) => void) {
  return new RolloverService({
    provider,
    enabled: true,
    intervalMs: 60_000,
    tickConfirmTimeoutMs: 1_000,
    discover: discover as never,
    ...(onChanged ? { onContractsChanged: onChanged } : {}),
  });
}

beforeEach(() => __resetRolloverState());

test("accepts a valid future contract", () => {
  const r = validateContract({ group: "gold", token: "466583", symbol: "GOLD05OCT99FUT", expiry: FUTURE });
  assert.equal(r.ok, true);
  assert.equal(r.expiryDate, "2099-10-05");
});

test("rejects an expired contract", () => {
  const r = validateContract({ group: "gold", token: "466583", symbol: "GOLD05OCT20FUT", expiry: PAST });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "contract already expired");
});

test("rejects an invalid expiry date", () => {
  const r = validateContract({ group: "silver", token: "471725", symbol: "SILVER", expiry: "31FEB2099" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid expiry date");
});

test("rejects missing or non-numeric token", () => {
  assert.equal(validateContract({ group: "gold", symbol: "GOLD05OCT99FUT", expiry: FUTURE }).ok, false);
  assert.equal(
    validateContract({ group: "gold", token: "ABC", symbol: "GOLD05OCT99FUT", expiry: FUTURE }).ok,
    false,
  );
});

test("gold rollover switches token and updates metadata", async () => {
  setActiveContracts([{ group: "gold", token: "1", symbol: "GOLD05SEP99FUT", expiry: "05SEP2099" }]);
  const provider = new FakeProvider(["1"]);
  let metadata: any = null;
  const svc = service(
    provider,
    async () => ({ contracts: [contract("gold", "2", "GOLD05OCT99FUT")] }),
    (c) => (metadata = c),
  );

  await svc.check();

  assert.deepEqual(provider.getSubscribed().map((i) => i.token), ["2"]);
  assert.deepEqual(provider.unsubscribed.map((i) => i.token), ["1"]);
  assert.equal(getRolloverState().currentContracts[0]?.token, "2");
  assert.equal(metadata[0].symbol, "GOLD05OCT99FUT");
});

test("silver rollover works independently of gold", async () => {
  setActiveContracts([
    { group: "gold", token: "1", symbol: "GOLD05SEP99FUT", expiry: "05SEP2099" },
    { group: "silver", token: "10", symbol: "SILVER05SEP99FUT", expiry: "05SEP2099" },
  ]);
  const provider = new FakeProvider(["1", "10"]);
  const svc = service(provider, async () => ({
    contracts: [
      contract("gold", "1", "GOLD05SEP99FUT", "05SEP2099"),
      contract("silver", "20", "SILVER05OCT99FUT"),
    ],
  }));

  await svc.check();

  const tokens = provider.getSubscribed().map((i) => i.token).sort();
  assert.deepEqual(tokens, ["1", "20"]);
  const state = getRolloverState();
  assert.equal(state.currentContracts.find((c) => c.group === "gold")?.token, "1");
  assert.equal(state.currentContracts.find((c) => c.group === "silver")?.token, "20");
});

test("a failing gold switch does not break silver", async () => {
  setActiveContracts([
    { group: "gold", token: "1", symbol: "GOLD05SEP99FUT", expiry: "05SEP2099" },
    { group: "silver", token: "10", symbol: "SILVER05SEP99FUT", expiry: "05SEP2099" },
  ]);
  const provider = new FakeProvider(["1", "10"]);
  const original = provider.subscribeInstruments.bind(provider);
  provider.subscribeInstruments = async (add: Instrument[]) => {
    if (add[0]?.token === "2") throw new Error("gold subscribe failed");
    return original(add);
  };
  const svc = service(provider, async () => ({
    contracts: [contract("gold", "2", "GOLD05OCT99FUT"), contract("silver", "20", "SILVER05OCT99FUT")],
  }));

  await svc.check();

  const state = getRolloverState();
  assert.equal(state.currentContracts.find((c) => c.group === "gold")?.token, "1");
  assert.equal(state.currentContracts.find((c) => c.group === "silver")?.token, "20");
  assert.ok(provider.getSubscribed().some((i) => i.token === "1"));
});

test("keeps working contract when ScripMaster is unavailable", async () => {
  setActiveContracts([{ group: "gold", token: "1", symbol: "GOLD05SEP99FUT", expiry: "05SEP2099" }]);
  const provider = new FakeProvider(["1"]);
  const svc = service(provider, async () => {
    throw new Error("ETIMEDOUT");
  });

  await svc.check();

  assert.deepEqual(provider.getSubscribed().map((i) => i.token), ["1"]);
  assert.equal(provider.unsubscribed.length, 0);
  assert.equal(getRolloverState().lastRolloverStatus, "failed");
});

test("never switches to an invalid or expired discovered contract", async () => {
  setActiveContracts([{ group: "gold", token: "1", symbol: "GOLD05SEP99FUT", expiry: "05SEP2099" }]);
  const provider = new FakeProvider(["1"]);
  const svc = service(provider, async () => ({
    contracts: [contract("gold", "2", "GOLD05OCT20FUT", PAST)],
  }));

  await svc.check();

  assert.deepEqual(provider.getSubscribed().map((i) => i.token), ["1"]);
  assert.equal(getRolloverState().currentContracts[0]?.token, "1");
});

test("drops stale ENV fallback tokens after first successful discovery", async () => {
  setActiveContracts([]);
  setEnvFallbackTokens(["999"]);
  const provider = new FakeProvider(["999"]);
  const svc = service(provider, async () => ({ contracts: [contract("gold", "2", "GOLD05OCT99FUT")] }));

  await svc.check();

  assert.deepEqual(provider.getSubscribed().map((i) => i.token), ["2"]);
  assert.deepEqual(provider.unsubscribed.map((i) => i.token), ["999"]);
  assert.deepEqual(getEnvFallbackTokens(), []);
});

test("unchanged contracts are not resubscribed", async () => {
  setActiveContracts([{ group: "gold", token: "1", symbol: "GOLD05OCT99FUT", expiry: FUTURE }]);
  const provider = new FakeProvider(["1"]);
  const svc = service(provider, async () => ({ contracts: [contract("gold", "1", "GOLD05OCT99FUT")] }));

  await svc.check();

  assert.deepEqual(provider.getSubscribed().map((i) => i.token), ["1"]);
  assert.equal(provider.unsubscribed.length, 0);
});

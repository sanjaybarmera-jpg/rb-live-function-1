import { loadEnv } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createProvider } from "./providers/registry.js";

import {
  discoverInstruments,
  loadConfiguredInstruments,
} from "./providers/angelone/instruments.js";

import { setDiscoveryState } from "./services/discoveryState.js";
import { setTokenGroup, getTokenGroups } from "./services/metals.js";
import {
  buildContractMonth,
  normalizeExpiryDate,
} from "./utils/expiry.js";

import {
  RolloverService,
  setActiveContracts,
  setEnvFallbackTokens,
  toActive,
  type ActiveContract,
  type RolloverCapableProvider,
} from "./services/rollover.js";

import { MarketEngine } from "./engine/MarketEngine.js";
import { HealthServer } from "./services/HealthServer.js";
import {
  MetalPriceService,
  setMetalPriceService,
} from "./services/MetalPriceService.js";
import type { Instrument } from "./providers/types.js";
import type { ContractMetadata } from "./services/RatesWriter.js";

interface ResolvedInstruments {
  instruments: Instrument[];
  contracts: ActiveContract[];
  rateContracts: ContractMetadata[];
}

/**
 * Resolve subscription instruments and contract metadata.
 * ScripMaster is the source of truth in AUTO mode.
 */
async function resolveInstruments(
  mode: "env" | "auto",
): Promise<ResolvedInstruments> {
  logger.info(
    { mode },
    `[boot] discovery mode: ${mode.toUpperCase()}`,
  );

  if (mode !== "auto") {
    setDiscoveryState({
      mode: "env",
      source: "env",
      timestamp: new Date().toISOString(),
    });

    return {
      instruments: loadConfiguredInstruments(),
      contracts: [],
      rateContracts: [],
    };
  }

  try {
    const result = await discoverInstruments();

    // Register tokens dynamically into metals.ts
    for (const c of result.contracts) {
      setTokenGroup(c.token, c.group);
    }

    setDiscoveryState({
      mode: "auto",
      source: "scripmaster",
      timestamp: result.discoveredAt,

      goldToken: result.contracts.find((c) => c.group === "gold")?.token,
      silverToken: result.contracts.find((c) => c.group === "silver")?.token,
      cacheAgeMs: result.cacheAgeMs,
    });

    /*
     * Convert discovery contracts into the exact metadata
     * RatesWriter needs.
     */
    const rateContracts: ContractMetadata[] = result.contracts.map((c) => ({
      group: c.group,
      token: c.token,
      contractSymbol: c.symbol,
      contractMonth: buildContractMonth(c.expiry),
      expiryDate: buildExpiryDate(c.expiry),
    }));

    logger.info(
      {
        contracts: rateContracts,
      },
      "[boot] rate contract metadata prepared",
    );

    return {
      instruments: result.instruments,
      contracts: result.contracts.map(toActive),
      rateContracts,
    };
  } catch (err) {
    logger.error(
      { err },
      "[boot] discovery failed",
    );

    logger.warn(
      "[boot] using ENV fallback (ANGEL_INSTRUMENTS / METAL_TOKEN_MAP)",
    );

    setDiscoveryState({
      mode: "auto",
      source: "env-fallback",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      instruments: loadConfiguredInstruments(),
      contracts: [],
      rateContracts: [],
    };
  }
}

/**
 * Convert Angel One expiry (e.g. 05OCT2026) into "2026-10-05".
 *
 * Delegates to the shared normalizer so no code path can ever
 * concatenate raw ScripMaster text into expiry_date.
 */
function buildExpiryDate(expiry: string): string {
  return normalizeExpiryDate(expiry);
}

async function main(): Promise<void> {
  const env = loadEnv();

  logger.info(
    { env: env.NODE_ENV },
    "[boot] rb-live-engine starting",
  );

  const provider = createProvider("angelone");

  const { instruments, contracts, rateContracts } = await resolveInstruments(
    env.INSTRUMENT_DISCOVERY,
  );

  const groups = getTokenGroups();
  const goldToken =
    instruments.find((i) => groups[i.token] === "gold")?.token ?? null;
  const silverToken =
    instruments.find((i) => groups[i.token] === "silver")?.token ?? null;

  const discoverySource =
    contracts.length > 0 ? "SCRIPMASTER" : "ENV_FALLBACK";

  logger.info(
    {
      discoverySource,
      angelInstrumentsConfigured: Boolean(env.ANGEL_INSTRUMENTS.trim()),
      metalTokenMapConfigured: Boolean(env.METAL_TOKEN_MAP.trim()),
      subscriptionTokenCount: instruments.length,
      subscriptionTokens: instruments.map((i) => i.token),
      goldResolved: Boolean(goldToken),
      silverResolved: Boolean(silverToken),
      goldToken,
      silverToken,
      goldTokenPresent: Boolean(goldToken),
      silverTokenPresent: Boolean(silverToken),
    },
    "[boot] final subscription list prepared",
  );

  if (instruments.length === 0) {
    logger.error(
      {
        discoverySource,
        recoveryIntervalMs: env.ROLLOVER_RECOVERY_INTERVAL_MS,
        expectedAngelInstrumentsFormat: "5:466583,5:471725",
        expectedMetalTokenMapFormat: "466583:gold,471725:silver",
      },
      "[boot] no instruments resolved — engine will retry ScripMaster discovery automatically until a contract is found",
    );
  }


  const engine = new MarketEngine({
    provider,
    instruments,
    enabledTimeframes: env.ENABLED_TIMEFRAMES,
    historyThrottleMs: env.HISTORY_THROTTLE_MS,
    maxTickAgeMs: env.MAX_TICK_AGE_MS,
    discoveredContracts: rateContracts,
  });

  const health = new HealthServer(env.PORT, () => engine.snapshot());
  health.start();

  await engine.start();

  // Seed rollover state
  setActiveContracts(contracts);

  // ScripMaster was unavailable at boot: remember the ENV tokens so the first
  // successful discovery can drop them instead of leaving two tokens mapped
  // to the same metal.
  if (contracts.length === 0) {
    setEnvFallbackTokens(instruments.map((i) => i.token));
  }

  const rolloverCapable = provider as unknown as Partial<RolloverCapableProvider>;
  let rollover: RolloverService | null = null;

  if (
    env.INSTRUMENT_DISCOVERY === "auto" &&
    typeof rolloverCapable.subscribeInstruments === "function" &&
    typeof rolloverCapable.unsubscribeInstruments === "function" &&
    typeof rolloverCapable.getSubscribed === "function"
  ) {
    rollover = new RolloverService({
      provider: rolloverCapable as RolloverCapableProvider,
      enabled: env.ROLLOVER_ENABLED,
      intervalMs: env.ROLLOVER_CHECK_INTERVAL_MS,
      recoveryIntervalMs: env.ROLLOVER_RECOVERY_INTERVAL_MS,
      tickConfirmTimeoutMs: env.ROLLOVER_TICK_CONFIRM_TIMEOUT_MS,
      onContractsChanged: (newContracts) => {
        const metadata: ContractMetadata[] = newContracts.map((c) => ({
          group: c.group,
          token: c.token,
          contractSymbol: c.symbol,
          contractMonth: buildContractMonth(c.expiry),
          expiryDate: buildExpiryDate(c.expiry),
        }));

        logger.info(
          { contracts: metadata },
          "[boot] rollover contract metadata received by RatesWriter",
        );

        engine.setDiscoveredContracts(metadata);
      },
    });

    /*
     * Boot could not resolve a contract (ScripMaster outage, no ENV fallback):
     * recover as soon as the network allows instead of waiting hours.
     */
    const needsRecovery = contracts.length === 0;

    if (needsRecovery) {
      logger.warn(
        { recoveryIntervalMs: env.ROLLOVER_RECOVERY_INTERVAL_MS },
        "[boot] no active contract — discovery recovery loop enabled",
      );
    }

    rollover.start(needsRecovery);
  }

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "[boot] shutdown signal received");

    const force = setTimeout(() => {
      logger.warn("[boot] graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);

    force.unref();

    try {
      rollover?.stop();
      await engine.stop();
      await health.stop();
    } catch (err) {
      logger.error({ err }, "[boot] error during shutdown");
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "[boot] fatal error");
  process.exit(1);
});

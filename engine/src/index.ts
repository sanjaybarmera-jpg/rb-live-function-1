import { loadEnv } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createProvider } from "./providers/registry.js";
import {
  discoverInstruments,
  loadConfiguredInstruments,
} from "./providers/angelone/instruments.js";
import { setDiscoveryState } from "./services/discoveryState.js";
import { MarketEngine } from "./engine/MarketEngine.js";
import { HealthServer } from "./services/HealthServer.js";
import type { Instrument } from "./providers/types.js";

/**
 * Resolve the subscription list. Discovery is opt-in (INSTRUMENT_DISCOVERY=auto)
 * and always degrades to the existing env configuration on failure.
 */
async function resolveInstruments(mode: "env" | "auto"): Promise<Instrument[]> {
  logger.info({ mode }, `[boot] discovery mode: ${mode.toUpperCase()}`);
  if (mode !== "auto") {
    setDiscoveryState({
      mode: "env",
      source: "env",
      timestamp: new Date().toISOString(),
    });
    return loadConfiguredInstruments();
  }

  try {
    const result = await discoverInstruments();
    setDiscoveryState({
      mode: "auto",
      source: "scripmaster",
      timestamp: result.discoveredAt,
      goldToken: result.contracts.find((c) => c.group === "gold")?.token,
      silverToken: result.contracts.find((c) => c.group === "silver")?.token,
      cacheAgeMs: result.cacheAgeMs,
    });
    return result.instruments;
  } catch (err) {
    logger.error({ err }, "[boot] discovery failed");
    logger.warn("[boot] using ENV fallback (ANGEL_INSTRUMENTS / METAL_TOKEN_MAP)");
    setDiscoveryState({
      mode: "auto",
      source: "env-fallback",
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return loadConfiguredInstruments();
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info({ env: env.NODE_ENV }, "[boot] rb-live-engine starting");

  const provider = createProvider("angelone");
  const instruments = await resolveInstruments(env.INSTRUMENT_DISCOVERY);

  if (instruments.length === 0) {
    logger.warn(
      "[boot] no instruments resolved — engine will connect but receive no ticks",
    );
  }

  const engine = new MarketEngine({
    provider,
    instruments,
    enabledTimeframes: env.ENABLED_TIMEFRAMES,
    historyThrottleMs: env.HISTORY_THROTTLE_MS,
    maxTickAgeMs: env.MAX_TICK_AGE_MS,
  });

  const health = new HealthServer(env.PORT, () => engine.snapshot());
  health.start();

  await engine.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "[boot] shutdown signal received");
    // Hard-exit guard so the container never hangs past the platform's grace period.
    const force = setTimeout(() => {
      logger.warn("[boot] graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
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
  process.on("unhandledRejection", (reason) =>
    logger.error({ reason }, "[boot] unhandled rejection"),
  );
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "[boot] uncaught exception");
    // Exit non-zero so Railway's restart policy replaces the unhealthy process.
    void shutdown("uncaughtException").then(() => process.exit(1));
  });

}

main().catch((err) => {
  logger.error({ err }, "[boot] fatal error");
  process.exit(1);
});

import { loadEnv } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createProvider } from "./providers/registry.js";
import { loadConfiguredInstruments } from "./providers/angelone/instruments.js";
import { MarketEngine } from "./engine/MarketEngine.js";
import { HealthServer } from "./services/HealthServer.js";

async function main(): Promise<void> {
  const env = loadEnv();
  logger.info({ env: env.NODE_ENV }, "[boot] rb-live-engine starting");

  const provider = createProvider("angelone");
  const instruments = loadConfiguredInstruments();

  if (instruments.length === 0) {
    logger.warn(
      "[boot] ANGEL_INSTRUMENTS is empty — engine will connect but receive no ticks",
    );
  }

  const engine = new MarketEngine({
    provider,
    instruments,
    enabledTimeframes: env.ENABLED_TIMEFRAMES,
    historyThrottleMs: env.HISTORY_THROTTLE_MS,
  });

  const health = new HealthServer(env.PORT, () => engine.snapshot());
  health.start();

  await engine.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "[boot] shutdown signal received");
    try {
      await engine.stop();
      await health.stop();
    } catch (err) {
      logger.error({ err }, "[boot] error during shutdown");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) =>
    logger.error({ reason }, "[boot] unhandled rejection"),
  );
  process.on("uncaughtException", (err) =>
    logger.error({ err }, "[boot] uncaught exception"),
  );
}

main().catch((err) => {
  logger.error({ err }, "[boot] fatal error");
  process.exit(1);
});

import { loadEnv } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { MarketEngine } from "./engine/MarketEngine.js";
import { HealthServer } from "./services/HealthServer.js";
import { RateBroadcaster } from "./services/RateBroadcaster.js";
import {
  GenericRateService,
  setGenericRateService,
} from "./services/GenericRateService.js";
import {
  buildHttpConfig,
  buildParserConfig,
  isGenericApiConfigured,
} from "./providers/genericapi/config.js";
import {
  UsdRatesWriter,
  setUsdRatesWriter,
} from "./services/UsdRatesWriter.js";

async function main(): Promise<void> {
  const env = loadEnv();

  logger.info({ env: env.NODE_ENV }, "[boot] rb-live-engine starting");

  const broadcaster = new RateBroadcaster();

  const engine = new MarketEngine({
    enabledTimeframes: env.ENABLED_TIMEFRAMES,
    historyThrottleMs: env.HISTORY_THROTTLE_MS,
    maxTickAgeMs: env.MAX_TICK_AGE_MS,
    // The generic rate API carries no futures contract — price-only writes.
    allowMissingContract: true,
    broadcaster,
  });

  const health = new HealthServer(
    env.PORT,
    () => engine.snapshot(),
    broadcaster,
    env.SSE_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  );
  health.start();

  /*
   * The generic, provider-agnostic HTTP rate API is the ONLY live source.
   * Everything is configuration driven (RATE_API_*, GOLD_*, SILVER_*).
   */
  let rateApi: GenericRateService | null = null;

  if (isGenericApiConfigured(env)) {
    rateApi = new GenericRateService({
      http: buildHttpConfig(env),
      parser: buildParserConfig(env),
      intervalMs: env.RATE_API_INTERVAL_MS,
      maxAgeMs: env.RATE_API_MAX_AGE_MS,
      priceField: env.RATE_API_PRICE_FIELD,
      onRates: (tick) => engine.ingestExternalTick(tick),
    });

    setGenericRateService(rateApi);
  } else {
    logger.error(
      "[API] RATE_API_URL not set — no live rate source configured, no rates will be written",
    );
  }

  await engine.start();

  // Polling starts only after the rate writer is initialized.
  rateApi?.start();

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
      rateApi?.stop();
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

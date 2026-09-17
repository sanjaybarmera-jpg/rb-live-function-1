import { z } from "zod";

// Production (Railway/Docker) injects configuration purely through environment
// variables. A local .env file is a developer convenience only and is never
// required — it is loaded best-effort outside production.
if (process.env["NODE_ENV"] !== "production") {
  try {
    const { config } = await import("dotenv");
    config();
  } catch {
    /* dotenv not installed / no .env file — env vars only */
  }
}

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  /**
   * Generic HTTP rate API (provider agnostic) — the only live rate source.
   * Empty RATE_API_URL keeps the whole layer disabled.
   */
  RATE_API_URL: z.string().default(""),
  RATE_API_KEY: z.string().default(""),
  RATE_API_AUTH_TYPE: z.enum(["none", "query", "header", "bearer"]).default("query"),
  RATE_API_KEY_NAME: z.string().default("api_key"),
  RATE_API_METHOD: z.enum(["GET", "POST"]).default("GET"),
  /** Extra static headers / query params / POST body as JSON strings. */
  RATE_API_HEADERS: z.string().default(""),
  RATE_API_QUERY: z.string().default(""),
  RATE_API_BODY: z.string().default(""),
  RATE_API_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  RATE_API_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /** Reject responses older than this when the API exposes a timestamp. 0 = off. */
  RATE_API_MAX_AGE_MS: z.coerce.number().int().nonnegative().default(120_000),
  /** Which normalized field becomes the live price. */
  RATE_API_PRICE_FIELD: z.enum(["bid", "ask", "mid"]).default("bid"),

  /** Response mapping (generic — no provider-specific logic). */
  RATE_API_ITEMS_PATH: z.string().default(""),
  RATE_API_SYMBOL_FIELD: z.string().default("symbol"),
  RATE_API_TIMESTAMP_PATH: z.string().default(""),

  GOLD_SYMBOL: z.string().default(""),
  GOLD_BID_PATH: z.string().default(""),
  GOLD_ASK_PATH: z.string().default(""),
  GOLD_HIGH_PATH: z.string().default(""),
  GOLD_LOW_PATH: z.string().default(""),
  GOLD_PRICE_PATH: z.string().default(""),

  SILVER_SYMBOL: z.string().default(""),
  SILVER_BID_PATH: z.string().default(""),
  SILVER_ASK_PATH: z.string().default(""),
  SILVER_HIGH_PATH: z.string().default(""),
  SILVER_LOW_PATH: z.string().default(""),
  SILVER_PRICE_PATH: z.string().default(""),

  ENABLED_TIMEFRAMES: z.string().default("1m"),
  HISTORY_THROTTLE_MS: z.coerce.number().int().nonnegative().default(1000),
  /** Drop rates whose source timestamp is older than this (ms). 0 disables. */
  MAX_TICK_AGE_MS: z.coerce.number().int().nonnegative().default(120_000),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  NODE_ENV: z.string().default("development"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(
      "[env] invalid configuration:",
      parsed.error.flatten().fieldErrors,
    );
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

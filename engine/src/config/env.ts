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

  ANGEL_API_KEY: z.string().min(1),
  ANGEL_CLIENT_CODE: z.string().min(1),
  ANGEL_PIN: z.string().min(1),
  ANGEL_TOTP_SECRET: z.string().min(1),
  ANGEL_INSTRUMENTS: z.string().default(""),
  ANGEL_SUBSCRIPTION_MODE: z.coerce.number().int().min(1).max(3).default(2),

  /** "env" (default, existing behaviour) or "auto" (ScripMaster discovery). */
  INSTRUMENT_DISCOVERY: z.enum(["env", "auto"]).default("env"),
  /** ScripMaster cache lifetime in ms. Default 6h. */
  SCRIPMASTER_CACHE_TTL: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  /** Skip contracts expiring within this many days. Default 2. */
  ROLLOVER_DAYS_BEFORE_EXPIRY: z.coerce.number().int().nonnegative().default(2),
  MCX_GOLD_SYMBOL_PREFIX: z.string().default("GOLD"),
  MCX_SILVER_SYMBOL_PREFIX: z.string().default("SILVER"),

  /** Automatic contract rollover (only active when discovery mode is "auto"). */
  ROLLOVER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Rollover check interval in ms. Default 6h. */
  ROLLOVER_CHECK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(6 * 60 * 60 * 1000),


  ENABLED_TIMEFRAMES: z.string().default("1m"),
  HISTORY_THROTTLE_MS: z.coerce.number().int().nonnegative().default(1000),
  /** Drop ticks whose exchange timestamp is older than this (ms). 0 disables the guard. */
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

export interface ParsedInstrument {
  exchangeType: number;
  token: string;
}

export function parseInstruments(raw: string): ParsedInstrument[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [exch, token] = entry.split(":");
      if (!exch || !token) {
        throw new Error(`Invalid instrument entry "${entry}" — expected EXCHANGE:TOKEN`);
      }
      return { exchangeType: Number(exch), token };
    });
}

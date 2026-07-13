import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  ANGEL_API_KEY: z.string().min(1),
  ANGEL_CLIENT_CODE: z.string().min(1),
  ANGEL_PIN: z.string().min(1),
  ANGEL_TOTP_SECRET: z.string().min(1),
  ANGEL_INSTRUMENTS: z.string().default(""),
  ANGEL_SUBSCRIPTION_MODE: z.coerce.number().int().min(1).max(3).default(2),

  ENABLED_TIMEFRAMES: z.string().default("1m"),
  HISTORY_THROTTLE_MS: z.coerce.number().int().nonnegative().default(1000),
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

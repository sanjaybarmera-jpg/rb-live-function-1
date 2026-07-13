import type { MarketDataProvider } from "./types.js";
import { AngelOneProvider } from "./angelone/index.js";
import { loadEnv } from "../config/env.js";

export type ProviderName = "angelone";

export function createProvider(name: ProviderName): MarketDataProvider {
  const env = loadEnv();
  switch (name) {
    case "angelone":
      return new AngelOneProvider({
        apiKey: env.ANGEL_API_KEY,
        clientCode: env.ANGEL_CLIENT_CODE,
        pin: env.ANGEL_PIN,
        totpSecret: env.ANGEL_TOTP_SECRET,
        subscriptionMode: env.ANGEL_SUBSCRIPTION_MODE,
      });
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown provider: ${_exhaustive as string}`);
    }
  }
}

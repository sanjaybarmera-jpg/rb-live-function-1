import axios from "axios";
import speakeasy from "speakeasy";
import { logger } from "../../utils/logger.js";

const LOGIN_URL =
  "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword";

export interface AngelCredentials {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
}

export interface AngelSession {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  /** Wall-clock ms when these tokens were issued by Angel One. */
  issuedAt: number;
}

/**
 * Angel One session tokens are valid for roughly 24h. We treat anything older
 * than 8h as "needs refresh" so a reconnect never races the hard expiry.
 */
export const TOKEN_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** True when the session is present and young enough to reuse as-is. */
export function isSessionFresh(
  session: AngelSession | null,
  maxAgeMs: number = TOKEN_MAX_AGE_MS,
): boolean {
  if (!session) return false;
  return Date.now() - session.issuedAt < maxAgeMs;
}

export async function loginAngelOne(creds: AngelCredentials): Promise<AngelSession> {
  const totp = speakeasy.totp({ secret: creds.totpSecret, encoding: "base32" });

  const { data } = await axios.post(
    LOGIN_URL,
    {
      clientcode: creds.clientCode,
      password: creds.pin,
      totp,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": creds.apiKey,
      },
      timeout: 15_000,
    },
  );

  if (!data || data.status === false || !data.data) {
    logger.error({ resp: data }, "[angelone] login failed");
    throw new Error(`Angel One login failed: ${data?.message ?? "unknown"}`);
  }

  const { jwtToken, refreshToken, feedToken } = data.data as {
    jwtToken: string;
    refreshToken: string;
    feedToken: string;
  };

  logger.info("[angelone] login ok, tokens acquired");
  return { jwtToken, refreshToken, feedToken };
}

import { loadEnv, parseInstruments } from "../../config/env.js";
import type { Instrument } from "../types.js";

/** Load the configured instrument subscription list from env. */
export function loadConfiguredInstruments(): Instrument[] {
  const env = loadEnv();
  const parsed = parseInstruments(env.ANGEL_INSTRUMENTS);
  return parsed.map((p) => ({ exchangeType: p.exchangeType, token: p.token }));
}

const EXCHANGE_NAMES: Record<number, string> = {
  1: "NSE_CM",
  2: "NSE_FO",
  3: "BSE_CM",
  4: "BSE_FO",
  5: "MCX_FO",
  7: "NCX_FO",
  13: "CDE_FO",
};

export function exchangeName(exchangeType: number): string {
  return EXCHANGE_NAMES[exchangeType] ?? `EXCH_${exchangeType}`;
}

import { logger } from "../utils/logger.js";
import { getSupabase } from "./supabase.js";
import type { RatesDbClient } from "./RatesWriter.js";
import type { RateBroadcaster } from "./RateBroadcaster.js";

/**
 * UsdRatesWriter
 *
 * Writes the three non-MCX spot sources to their EXISTING Ratan Bullion
 * `rates` rows. Provider ids/symbols are never used as row identifiers —
 * the RB internal id is the only row selector:
 *
 *   USD-INR    -> usd_inr
 *   USD GOLD   -> usd_gold
 *   USD SILVER -> usd_silver
 *
 * No schema change, no upsert, no new rows: a plain UPDATE on the exact
 * internal id, validated by the returned affected rows.
 */
export type UsdRowId = "usd_inr" | "usd_gold" | "usd_silver";

export const USD_ROW_IDS: UsdRowId[] = ["usd_inr", "usd_gold", "usd_silver"];

export interface UsdWriteInput {
  id: UsdRowId;
  ltp: number;
  high: number | null;
  low: number | null;
  /** Timestamp of the successful fetch that produced this value. */
  fetchedAt: string;
}

export interface UsdWriteStatus {
  lastValue: number | null;
  high: number | null;
  low: number | null;
  writes: number;
  failures: number;
  affectedRows: number | null;
  lastWriteAt: string | null;
  lastError: string | null;
}

function emptyStatus(): UsdWriteStatus {
  return {
    lastValue: null,
    high: null,
    low: null,
    writes: 0,
    failures: 0,
    affectedRows: null,
    lastWriteAt: null,
    lastError: null,
  };
}

export class UsdRatesWriter {
  private status = new Map<UsdRowId, UsdWriteStatus>();
  private inFlight = new Set<UsdRowId>();
  /** Last written value per row — identical values are not re-written. */
  private lastWritten = new Map<UsdRowId, string>();

  constructor(
    private db: () => RatesDbClient = () =>
      getSupabase() as unknown as RatesDbClient,
    private broadcaster?: RateBroadcaster,
  ) {}

  statusFor(id: UsdRowId): UsdWriteStatus {
    let s = this.status.get(id);
    if (!s) {
      s = emptyStatus();
      this.status.set(id, s);
    }
    return s;
  }

  diagnostics(): Record<UsdRowId, UsdWriteStatus> {
    const out = {} as Record<UsdRowId, UsdWriteStatus>;
    for (const id of USD_ROW_IDS) out[id] = { ...this.statusFor(id) };
    return out;
  }

  get healthy(): boolean {
    return USD_ROW_IDS.every((id) => this.statusFor(id).lastError === null);
  }

  async write(input: UsdWriteInput): Promise<boolean> {
    const { id } = input;
    const s = this.statusFor(id);

    if (!Number.isFinite(input.ltp) || input.ltp <= 0) {
      s.lastError = `invalid ltp for ${id}`;
      s.failures++;
      return false;
    }

    if (this.inFlight.has(id)) return false;

    const fingerprint = `${input.ltp}|${input.high}|${input.low}`;
    if (this.lastWritten.get(id) === fingerprint) return false;

    const payload: Record<string, unknown> = {
      mcx_ltp: input.ltp,
      /* Existing behaviour for the USD rows: buy = sell = LTP (no premium). */
      buy_price: input.ltp,
      sell_price: input.ltp,
      updated_at: input.fetchedAt,
    };

    if (Number.isFinite(input.high as number) && (input.high as number) > 0) {
      payload["high"] = input.high;
    }
    if (Number.isFinite(input.low as number) && (input.low as number) > 0) {
      payload["low"] = input.low;
    }

    this.inFlight.add(id);

    try {
      const { data, error } = await this.db()
        .from("rates")
        .update(payload)
        .in("metal_type", [id])
        .select("metal_type");

      if (error) {
        s.failures++;
        s.lastError = error.message;
        logger.error({ err: error.message, id }, "[rates:usd] update failed");
        return false;
      }

      const affectedRows = data?.length ?? 0;
      s.affectedRows = affectedRows;

      if (affectedRows === 0) {
        s.failures++;
        s.lastError = `update matched 0 rows for metal_type = ${id}`;
        logger.error(
          { id, affectedRows: 0 },
          "[rates:usd] update affected 0 rows — treating as FAILURE",
        );
        return false;
      }

      s.writes++;
      s.lastValue = input.ltp;
      s.high = input.high;
      s.low = input.low;
      s.lastWriteAt = input.fetchedAt;
      s.lastError = null;
      this.lastWritten.set(id, fingerprint);

      this.broadcaster?.publish({
        metal: id,
        ltp: input.ltp,
        high: input.high ?? input.ltp,
        low: input.low ?? input.ltp,
        updated_at: input.fetchedAt,
      });

      return true;
    } catch (err) {
      s.failures++;
      s.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: s.lastError, id }, "[rates:usd] write failed");
      return false;
    } finally {
      this.inFlight.delete(id);
    }
  }
}

let active: UsdRatesWriter | null = null;

export function setUsdRatesWriter(w: UsdRatesWriter | null): void {
  active = w;
}

export function getUsdWriteDiagnostics():
  | Record<UsdRowId, UsdWriteStatus>
  | null {
  return active ? active.diagnostics() : null;
}

import { logger } from "../utils/logger.js";
import { getSupabase } from "./supabase.js";
import type { SpotSnapshot } from "./MetalPriceService.js";

/**
 * SpotRatesWriter
 *
 * Writes the MetalpriceAPI spot values into THREE pre-existing rows of the
 * existing `public.rates` table:
 *
 *   usd_gold   -> XAU/USD  (USD per troy ounce)
 *   usd_silver -> XAG/USD  (USD per troy ounce)
 *   usd_inr    -> USD/INR
 *
 * Hard rules:
 *  - UPDATE only, matched by the exact row id. Never upsert/insert.
 *  - A missing row is an error, never a reason to create one.
 *  - Only mcx_ltp, buy_price, sell_price, high, low, updated_at are touched.
 *  - The Angel One MCX rows (gold, silver, gold_999, ...) are never touched.
 */

export type SpotRowId = "usd_gold" | "usd_silver" | "usd_inr";

interface UpdateResult {
  data: { id: string }[] | null;
  error: { message: string } | null;
}

/** Minimal Supabase update-chain shape (injectable for tests). */
export interface SpotRatesDbClient {
  from(table: string): {
    update(payload: Record<string, unknown>): {
      eq(
        column: string,
        value: string,
      ): { select(columns: string): PromiseLike<UpdateResult> };
    };
  };
}

export interface SpotRowDiagnostics {
  rowId: SpotRowId;
  lastValue: number | null;
  lastUpdatedAt: string | null;
  updates: number;
  failures: number;
  skipped: number;
  lastError: string | null;
}

/** Reject snapshots older than this (provider timestamp). Default 30 min. */
const MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000;

const ROW_IDS: SpotRowId[] = ["usd_gold", "usd_silver", "usd_inr"];

function isValidValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export class SpotRatesWriter {
  private diagnostics = new Map<SpotRowId, SpotRowDiagnostics>();

  constructor(
    private db: () => SpotRatesDbClient = () =>
      getSupabase() as unknown as SpotRatesDbClient,
    private maxSnapshotAgeMs: number = MAX_SNAPSHOT_AGE_MS,
  ) {
    for (const rowId of ROW_IDS) {
      this.diagnostics.set(rowId, {
        rowId,
        lastValue: null,
        lastUpdatedAt: null,
        updates: 0,
        failures: 0,
        skipped: 0,
        lastError: null,
      });
    }
  }

  snapshot(): SpotRowDiagnostics[] {
    return ROW_IDS.map((id) => ({ ...this.diagnostics.get(id)! }));
  }

  private diag(rowId: SpotRowId): SpotRowDiagnostics {
    return this.diagnostics.get(rowId)!;
  }

  /**
   * Write one spot snapshot. NEVER throws — a failure here must not disturb
   * the Angel One / MCX pipeline in any way.
   */
  async write(snapshot: SpotSnapshot): Promise<void> {
    const timestamp = snapshot.providerTimestamp ?? snapshot.fetchedAt;
    const ageMs = Date.now() - Date.parse(timestamp);

    if (Number.isFinite(ageMs) && ageMs > this.maxSnapshotAgeMs) {
      for (const rowId of ROW_IDS) this.diag(rowId).skipped++;
      logger.warn(
        { ageMs, providerTimestamp: snapshot.providerTimestamp },
        "[metalprice] stale snapshot — usd_* rows not updated",
      );
      return;
    }

    const pairs: Array<[SpotRowId, number]> = [
      ["usd_gold", snapshot.goldUsdPerOz],
      ["usd_silver", snapshot.silverUsdPerOz],
      ["usd_inr", snapshot.usdInr],
    ];

    for (const [rowId, value] of pairs) {
      await this.updateRow(rowId, value, timestamp);
    }
  }

  private async updateRow(
    rowId: SpotRowId,
    value: number,
    timestamp: string,
  ): Promise<void> {
    const d = this.diag(rowId);

    if (!isValidValue(value)) {
      d.skipped++;
      logger.warn(
        { rowId, value },
        "[metalprice] invalid value — row not updated",
      );
      return;
    }

    try {
      const { data, error } = await this.db()
        .from("rates")
        .update({
          mcx_ltp: value,
          buy_price: value,
          sell_price: value,
          high: value,
          low: value,
          updated_at: timestamp,
        })
        .eq("id", rowId)
        .select("id");

      if (error) {
        d.failures++;
        d.lastError = error.message;
        logger.error(
          { rowId, err: error.message },
          "[metalprice] Supabase update failed",
        );
        return;
      }

      const affected = data?.length ?? 0;

      if (affected === 0) {
        d.failures++;
        d.lastError = "row not found";
        logger.error(
          { rowId, affectedRows: 0 },
          "[metalprice] existing row not found — NOT inserting a replacement row",
        );
        return;
      }

      d.updates++;
      d.lastValue = value;
      d.lastUpdatedAt = timestamp;
      d.lastError = null;

      logger.info(
        { rowId, value, affectedRows: affected, providerTimestamp: timestamp },
        `[metalprice] ${rowId} updated`,
      );
    } catch (err) {
      d.failures++;
      d.lastError = err instanceof Error ? err.message : String(err);
      logger.error(
        { rowId, err: d.lastError },
        "[metalprice] Supabase update threw",
      );
    }
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";

process.env["SUPABASE_URL"] ??= "https://example.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test";
process.env["ANGEL_API_KEY"] ??= "test";
process.env["ANGEL_CLIENT_CODE"] ??= "test";
process.env["ANGEL_PIN"] ??= "1234";
process.env["ANGEL_TOTP_SECRET"] ??= "test";

const { toInrPerGram } = await import("../src/services/MetalPriceService.js");

test("gold INR per gram conversion", () => {
  // 2000 USD/oz at 83 INR/USD -> (2000*83)/31.1034768
  assert.ok(Math.abs(toInrPerGram(2000, 83) - (2000 * 83) / 31.1034768) < 1e-9);
  assert.ok(Math.abs(toInrPerGram(2000, 83) - 5337.02) < 0.05);
});

test("silver INR per gram conversion", () => {
  assert.ok(Math.abs(toInrPerGram(25, 83) - 66.72) < 0.05);
});

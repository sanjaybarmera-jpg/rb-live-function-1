# SSE live-rate output

The engine exposes the additive customer-facing stream on the same port as the existing health server:

`GET /stream`

SSE is controlled by `SSE_ENABLED` (default `true`). Configure the CORS allowlist with `SSE_ALLOWED_ORIGINS` as a comma-separated list. `SSE_HEARTBEAT_MS` defaults to `15000`, and `SSE_MAX_CLIENTS` defaults to `5000`.

The stream emits standard `snapshot` and `rate` events and sends `:` heartbeats. It uses the final rate state after the existing engine writer has accepted the tick; the Supabase write path remains unchanged.

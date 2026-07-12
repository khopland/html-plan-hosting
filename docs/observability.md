# Observability

Workers Logs emit structured JSON for these events:

- `plan_created`: plan ID, token hash, HTML size, and TTL
- `plan_deleted`: plan ID and token hash
- `upload_rate_limited`: token hash, configured limit, and retry delay
- `internal_error`: request ID, method, path, and server-side exception message

Observability is enabled in `wrangler.jsonc`. Use Workers Logs and Traces to filter by event name. Alert on any `internal_error` event and on sustained increases in `upload_rate_limited` events. Correlate caller-visible `request_id` values with the matching internal error log.

The production deployment workflow runs a public health check after every main-branch deployment. The runtime integration suite separately verifies uploads, preview policy, Durable Object rate enforcement, expiry, CORS, and unavailable-record behavior.

Analytics Engine is intentionally not a deployment dependency because it requires an account-level dashboard opt-in. It can be added later if long-term custom metric aggregation is needed; Workers Logs remain the authoritative operational signal for this service.

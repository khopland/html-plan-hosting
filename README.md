# Agent HTML Plan Host

A Hono-powered Cloudflare Workers microservice for agent-generated HTML plans.

Agents upload one HTML document and receive a short-lived preview URL:

```sh
curl -X POST "https://your-worker.example.workers.dev/v1/plans" \
  -H "Authorization: Bearer $PLAN_HOST_TOKEN" \
  -H "Content-Type: text/html" \
  --data-binary @plan.html
```

Response:

```json
{
  "id": "8Gm3kQ...",
  "url": "https://plans.example.com/p/8Gm3kQ...",
  "metadata_url": "https://plans.example.com/v1/plans/8Gm3kQ...",
  "expires_at": "2026-07-14T17:00:00.000Z",
  "sha256": "..."
}
```

## Why KV for the first version

This implementation targets the Cloudflare free plan. Current Cloudflare limits are a good fit for a small personal/service MVP when uploads are capped:

- Workers: 100,000 requests/day.
- Workers KV: 1 GB storage, 100,000 reads/day, 1,000 writes/day.
- KV value size: 25 MiB.

This app defaults to a stricter 1 MiB HTML upload cap and seven-day TTL. Each upload uses two KV writes for the plan plus one short-lived KV write for rate limiting.

## Security model

Uploaded HTML is treated as untrusted.

- Upload/admin endpoints require `Authorization: Bearer <token>`.
- Preview pages are served with no cookies required.
- Preview responses set a restrictive CSP:
  - `default-src 'none'`
  - no JavaScript execution by default
  - images/fonts only from `data:` or `https:`
  - no forms
  - no framing
  - CSP `sandbox`
- Plan IDs are random URL-safe tokens.
- KV expiration automatically removes stored plans.
- Uploads are rate limited per bearer token hash.

For production, use a separate hostname for previews, for example:

- API/admin: `html-plan-api.example.com`
- Preview: `plans.example.com`

This Worker can serve both paths, but keeping preview links on a distinct hostname is still the right deployment shape.

## Local setup

Install dependencies:

```sh
npm install
```

Create `.dev.vars`:

```sh
PLAN_HOST_TOKEN=replace-with-a-long-random-token
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

Run locally:

```sh
npm run dev
```

Upload a local plan:

```sh
curl -X POST "http://127.0.0.1:8787/v1/plans" \
  -H "Authorization: Bearer replace-with-a-long-random-token" \
  -H "Content-Type: text/html" \
  --data-binary @index.html
```

## Tests

```sh
npm test
npm run typecheck
```

## Cloudflare deployment

You will need to log in for the deploy steps:

```sh
npx wrangler login
```

Create a KV namespace:

```sh
npx wrangler kv namespace create PLANS
```

Copy the returned namespace ID into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "PLANS",
    "id": "your-real-namespace-id"
  }
]
```

Set the upload token as a Worker secret:

```sh
npx wrangler secret put PLAN_HOST_TOKEN
```

For production, update `PUBLIC_BASE_URL` in `wrangler.jsonc` to the public preview base URL:

```jsonc
"PUBLIC_BASE_URL": "https://plans.example.com"
```

Deploy:

```sh
npm run deploy
```

## Routes

### `POST /v1/plans`

Authenticated. Accepts either `text/html` or JSON:

```json
{
  "title": "Migration plan",
  "ttl_seconds": 86400,
  "html": "<!doctype html>..."
}
```

### `GET /p/:id`

Public preview URL. Serves the uploaded HTML with locked-down headers.

### `HEAD /p/:id`

Public preview header check. Useful for link inspectors and health checks.

### `GET /v1/plans`

Authenticated admin listing. Supports optional `limit` and `cursor` query parameters:

```sh
curl "https://your-worker.example.workers.dev/v1/plans?limit=25" \
  -H "Authorization: Bearer $PLAN_HOST_TOKEN"
```

### `GET /v1/plans/:id`

Authenticated metadata lookup.

### `DELETE /v1/plans/:id`

Authenticated deletion.

## Free-plan notes

The free-plan write cap is the practical limit. Since each plan writes two KV keys plus one rate-limit counter, expect roughly 333 uploads/day before hitting KV write limits. Deletes also count as delete operations. If you outgrow this, move content to R2 and keep only metadata/rate limits in KV, D1, or Durable Objects.

KV is eventually consistent. This is acceptable for generated preview plans, but immediately reading a just-written plan from a far-away Cloudflare location can theoretically lag. If that becomes a problem, move to Durable Objects or D1/R2.

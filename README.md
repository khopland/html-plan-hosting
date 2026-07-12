# Agent HTML Plan Host

A Hono-powered Cloudflare Workers microservice for agent-generated HTML plans.

This repository also contains a ready-to-install agent skill in `SKILL.md` and its uploader in `scripts/upload-html-plan.mjs`.

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

This app defaults to a stricter 1 MiB HTML upload cap and seven-day TTL. Request bodies are stopped while streaming once their configured ceiling is exceeded. Each successful upload uses two KV writes; rate-limit state lives in a SQLite-backed Durable Object.

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
- Valid uploads reserve quota atomically through a per-token Durable Object. Rejected uploads do not consume quota.

For production, use a separate hostname for previews, for example:

- API/admin: `html-plan-api.example.com`
- Preview: `plans.example.com`

This Worker can serve both paths, but keeping preview links on a distinct hostname is still the right deployment shape.
Set `API_HOSTNAME` and `PREVIEW_HOSTNAME` to enforce that split at the Worker. Requests for an API route on the preview hostname, or a preview route on the API hostname, then return 404.

The Worker emits structured JSON events named `plan_created`, `plan_deleted`, and `upload_rate_limited`. Internal failures use an error event with a request ID. Workers Logs and Traces can alert on these events without exposing exception details to callers.

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
npm run test:integration
npm run typecheck
npm run check
```

## GitHub CI/CD

The repo includes `.github/workflows/cloudflare-worker.yml`.

CI runs on pull requests and pushes to `main`:

- `npm ci`
- `npm run typecheck`
- `npm test`
- `npx wrangler deploy --dry-run`

CD runs only on pushes to `main`, after CI passes. It deploys with Wrangler and smoke-tests the public health endpoint.

Add this GitHub repository secret before enabling CD:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with permission to deploy this Worker and read/write its KV namespace.

Recommended Cloudflare API token permissions:

- Account: `Workers Scripts:Edit`
- Account: `Workers KV Storage:Edit`
- Account: `Account Settings:Read`

The Worker upload secret `PLAN_HOST_TOKEN` stays in Cloudflare as a Worker secret and does not need to be added to GitHub for deploys.

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

The free-plan write cap is the practical limit. Since each plan writes two KV keys, expect roughly 500 uploads/day before hitting KV write limits. Deletes also count as delete operations. If you outgrow this, move content to R2 and keep metadata in KV or D1; the atomic rate limiter can remain in Durable Objects.

KV is eventually consistent. This is acceptable for generated preview plans, but immediately reading a just-written plan from a far-away Cloudflare location can theoretically lag. If that becomes a problem, move to Durable Objects or D1/R2.

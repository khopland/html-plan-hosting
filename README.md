# HTML Plan Host

A tiny Cloudflare Worker that stores an HTML file in KV and returns a temporary public link.

## What it does

- `POST /v1/plans` uploads HTML with a bearer secret.
- `GET /p/:id` displays it for up to seven days.
- Each plan costs one KV write.
- Preview pages use a restrictive CSP that blocks scripts, forms, and framing.
- Uploads are limited to 1 MiB.

## Local setup

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Set a different long random secret for each machine, separated by commas or newlines:

```text
PLAN_HOST_TOKENS=laptop-secret,phone-secret,desktop-secret
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

Upload a plan:

```sh
PLAN_HOST_TOKEN=laptop-secret node scripts/upload-html-plan.mjs plan.html
```

The old server setting `PLAN_HOST_TOKEN` still works when only one secret is needed.

## Deploy

Create a KV namespace and put its ID in `wrangler.jsonc`, then set the secrets as one Cloudflare secret:

```sh
npx wrangler login
npx wrangler kv namespace create PLANS
npx wrangler secret put PLAN_HOST_TOKENS
npm run deploy
```

When prompted, enter a comma-separated list such as `laptop-secret,phone-secret`.

Run all checks with:

```sh
npm run check
```

## API

Raw HTML:

```sh
curl -X POST https://your-worker.example/v1/plans \
  -H "Authorization: Bearer $PLAN_HOST_TOKEN" \
  -H "Content-Type: text/html" \
  --data-binary @plan.html
```

JSON is also accepted by the bundled uploader:

```json
{ "html": "<!doctype html>...", "ttl_seconds": 86400 }
```

TTL is clamped between one minute and seven days. Links are public to anyone who knows the random URL.

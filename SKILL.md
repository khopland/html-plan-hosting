---
name: host-html-plan
description: Generate a complete self-contained HTML page for a plan, report, proposal, architecture, or implementation outline, upload it to the Agent HTML Plan Host Cloudflare Worker, and return the hosted preview URL.
---

# Host HTML Plan

## Workflow

1. Generate a complete self-contained HTML page.
   - Include `<!doctype html>`, `<html>`, `<head>`, responsive CSS, and meaningful body content.
   - Keep assets inline or remote over `https:`; the host accepts one HTML document, not a folder.
   - Prefer a polished plan page over a Markdown-like dump. Use clear sections, decisions, risks, milestones, and next actions.
   - Do not rely on JavaScript for core readability. The hosted preview blocks scripts by default.
2. Save the page to a descriptive local `.html` file.
3. Upload it with the bundled script:

   ```sh
   node scripts/upload-html-plan.mjs path/to/plan.html
   ```

4. Return the hosted URL printed by the script.
   - Mention the expiry when present.
   - Do not reveal the bearer token.
   - Warn that anyone with the bearer URL can view the page until expiry or deletion when content is sensitive.

## Configuration

The uploader checks, in order:

1. `HTML_PLAN_HOST_TOKEN`
2. `PLAN_HOST_TOKEN`
3. the nearest `.dev.vars` file
4. `~/.config/html-plan-host/env`

The config file format is:

```text
PLAN_HOST_TOKEN=...
```

`PLAN_HOST_TOKEN` is the secret assigned to this machine. The server accepts multiple
machine secrets from its comma- or whitespace-separated `PLAN_HOST_TOKENS` secret.

Optional environment variables:

- `HTML_PLAN_HOST_BASE_URL`: override the Worker URL.
- `HTML_PLAN_HOST_TTL_SECONDS`: request a TTL in seconds.

Optional flags:

```sh
node scripts/upload-html-plan.mjs plan.html --ttl 86400 --title "Migration plan" --base-url https://plans.example.com
```

If upload credentials are missing, ask the user to set `PLAN_HOST_TOKEN` or add it to `~/.config/html-plan-host/env`. If the user requests only a local file, do not upload it.

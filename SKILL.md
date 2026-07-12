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
   - Use the house style below unless the user requests another visual direction.
2. Save the page to a descriptive local `.html` file.
3. Upload it with the bundled script:

   ```sh
   node scripts/upload-html-plan.mjs path/to/plan.html
   ```

4. Return the hosted URL printed by the script.
   - Mention the expiry when present.
   - Do not reveal the bearer token.
   - Warn that anyone with the bearer URL can view the page until expiry or deletion when content is sensitive.
   - Preserve the returned `id` and `update_token` when the plan may need revisions. Never reveal the update token.

## Updating a hosted plan

When revising an existing plan, edit its local HTML file and upload a new immutable version:

```sh
node scripts/upload-html-plan.mjs plan.html \
  --plan-id PLAN_ID \
  --update-token UPDATE_TOKEN \
  --change-summary "Added rollout checks"
```

Return the stable plan URL. Mention the new version number and concise change summary. If the update token is unavailable, create a new plan; it cannot be recovered from the host.

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

## House style

Keep plans editorial, warm, and compact:

- Palette: ink `#18201b`, muted `#667168`, paper `#f3f0e8`, cards `#fffdf7`, line `#d8d4c8`, teal `#276c72`, green `#276547`, amber `#b97913`, red `#bd3f36`.
- Use Georgia for display headings and the system sans-serif stack for body text.
- Add the subtle 7px dotted paper texture used by `code-review-improvement-plan.html`.
- Prefer square, one-pixel bordered cards; avoid rounded dashboard-style panels and gradients.
- Use small uppercase teal eyebrow labels, generous section rules, and amber offset shadows only for a primary callout.
- Tables use full borders and a slightly darker paper header. Code uses a warm gray inline background.
- Keep the layout responsive: multi-column sections collapse to one column below 760px.

For plan revision navigation, use a compact off-white bar with a dark top border, teal text links, a centered Georgia version label, and clear disabled states. Include Previous, Next, Latest, and History links without JavaScript.

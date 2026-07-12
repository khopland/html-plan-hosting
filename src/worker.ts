export interface Env {
  PLANS: KVNamespace;
  PLAN_HOST_TOKENS?: string;
  PLAN_HOST_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
}

interface Latest {
  version: number;
  updateTokenHash: string;
  expiresAt: string;
}

interface Revision {
  version: number;
  createdAt: string;
  summary: string;
}

const DEFAULT_TTL = 7 * 24 * 60 * 60;
const MIN_TTL = 60;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_VERSIONS = 100;
const ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;

const PREVIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, max-age=60",
  "content-security-policy":
    "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return json({ service: "agent-html-plan-host", ok: true });
      }
      if (request.method === "POST" && url.pathname === "/v1/plans") {
        return createPlan(request, env);
      }

      const updateId = url.pathname.match(/^\/v1\/plans\/([^/]+)$/)?.[1];
      if (request.method === "POST" && updateId) return updatePlan(updateId, request, env);

      const historyId = url.pathname.match(/^\/p\/([^/]+)\/history$/)?.[1];
      if (request.method === "GET" && historyId) return showHistory(historyId, env);

      const versionMatch = url.pathname.match(/^\/p\/([^/]+)\/v\/(\d+)$/);
      if (versionMatch && (request.method === "GET" || request.method === "HEAD")) {
        return preview(versionMatch[1], env, request.method === "HEAD", Number(versionMatch[2]));
      }

      const id = url.pathname.match(/^\/p\/([^/]+)$/)?.[1];
      if (id && (request.method === "GET" || request.method === "HEAD")) {
        return preview(id, env, request.method === "HEAD");
      }
      return json({ error: "not_found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error" }, 500);
    }
  }
};

async function createPlan(request: Request, env: Env): Promise<Response> {
  if (!(await authenticated(request, env))) return json({ error: "unauthorized" }, 401);
  const input = await readUpload(request);
  if (!input.ok) return input.response;

  const id = randomId();
  const updateToken = randomId();
  const createdAt = new Date().toISOString();
  const latest: Latest = {
    version: 1,
    updateTokenHash: await sha256(updateToken),
    expiresAt: new Date(Date.now() + input.ttl * 1000).toISOString()
  };
  const history: Revision[] = [{ version: 1, createdAt, summary: "Initial version" }];

  await env.PLANS.put(versionKey(id, 1), input.html, { expirationTtl: input.ttl });
  await env.PLANS.put(historyKey(id), JSON.stringify(history), { expirationTtl: input.ttl });
  await env.PLANS.put(latestKey(id), JSON.stringify(latest), { expirationTtl: input.ttl });

  const baseUrl = publicBaseUrl(env, request);
  return json({
    id,
    url: `${baseUrl}/p/${id}`,
    version_url: `${baseUrl}/p/${id}/v/1`,
    history_url: `${baseUrl}/p/${id}/history`,
    update_token: updateToken,
    version: 1,
    expires_at: latest.expiresAt
  }, 201);
}

async function updatePlan(id: string, request: Request, env: Env): Promise<Response> {
  if (!(await authenticated(request, env))) return json({ error: "unauthorized" }, 401);
  if (!ID_PATTERN.test(id)) return json({ error: "not_found" }, 404);

  const body = await readBody(request, MAX_HTML_BYTES + 4096);
  if (!body.ok) return body.response;
  let input: { html?: unknown; update_token?: unknown; change_summary?: unknown };
  try { input = JSON.parse(body.value); } catch { return json({ error: "invalid_request" }, 400); }
  const htmlError = validateHtml(input.html);
  if (htmlError) return htmlError;
  if (typeof input.update_token !== "string" || typeof input.change_summary !== "string") {
    return json({ error: "invalid_request", message: "update_token and change_summary are required." }, 400);
  }

  const [latest, history] = await Promise.all([
    getJson<Latest>(env, latestKey(id)),
    getJson<Revision[]>(env, historyKey(id))
  ]);
  if (!latest || !history) return json({ error: "not_found" }, 404);
  if (!equalText(await sha256(input.update_token), latest.updateTokenHash)) {
    return json({ error: "invalid_update_token" }, 403);
  }
  if (latest.version >= MAX_VERSIONS) return json({ error: "version_limit_reached" }, 409);

  const ttl = Math.floor((Date.parse(latest.expiresAt) - Date.now()) / 1000);
  if (ttl < MIN_TTL) return json({ error: "plan_expiring" }, 409);
  const summary = input.change_summary.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!summary) return json({ error: "invalid_request", message: "change_summary cannot be empty." }, 400);

  // ponytail: KV updates assume one writer; use a Durable Object if concurrent updates become real.
  const version = latest.version + 1;
  const nextHistory = [...history, { version, createdAt: new Date().toISOString(), summary }];
  await env.PLANS.put(versionKey(id, version), input.html as string, { expirationTtl: ttl });
  await env.PLANS.put(historyKey(id), JSON.stringify(nextHistory), { expirationTtl: ttl });
  await env.PLANS.put(latestKey(id), JSON.stringify({ ...latest, version }), { expirationTtl: ttl });

  const baseUrl = publicBaseUrl(env, request);
  return json({
    id,
    url: `${baseUrl}/p/${id}`,
    version_url: `${baseUrl}/p/${id}/v/${version}`,
    history_url: `${baseUrl}/p/${id}/history`,
    version,
    expires_at: latest.expiresAt
  });
}

async function preview(id: string, env: Env, head: boolean, requestedVersion?: number): Promise<Response> {
  if (!ID_PATTERN.test(id)) return unavailable();
  const latest = await getJson<Latest>(env, latestKey(id));

  // Old one-key plans remain readable until their existing TTL expires.
  if (!latest) {
    const legacyHtml = requestedVersion === undefined ? await env.PLANS.get(id, "text") : null;
    return legacyHtml ? new Response(head ? null : legacyHtml, { headers: PREVIEW_HEADERS }) : unavailable();
  }

  const version = requestedVersion ?? latest.version;
  if (!Number.isInteger(version) || version < 1 || version > latest.version) return unavailable();
  const html = await env.PLANS.get(versionKey(id, version), "text");
  if (!html) return unavailable();
  return new Response(head ? null : injectNavigation(html, id, version, latest.version), { headers: PREVIEW_HEADERS });
}

async function showHistory(id: string, env: Env): Promise<Response> {
  if (!ID_PATTERN.test(id)) return unavailable();
  const [latest, history] = await Promise.all([
    getJson<Latest>(env, latestKey(id)),
    getJson<Revision[]>(env, historyKey(id))
  ]);
  if (!latest || !history) return unavailable();

  const rows = [...history].reverse().map((revision) =>
    `<li><a href="/p/${id}/v/${revision.version}">Version ${revision.version}</a><time>${escapeHtml(new Date(revision.createdAt).toLocaleString("en-GB", { timeZone: "UTC" }))} UTC</time><p>${escapeHtml(revision.summary)}</p></li>`
  ).join("");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plan history</title><style>${historyCss()}</style></head><body><main><div class="eyebrow">Plan revisions</div><h1>Version history</h1><p class="lede"><a href="/p/${id}">View latest version (${latest.version})</a></p><ol>${rows}</ol></main></body></html>`, { headers: PREVIEW_HEADERS });
}

type UploadResult = { ok: true; html: string; ttl: number } | { ok: false; response: Response };

async function readUpload(request: Request): Promise<UploadResult> {
  const body = await readBody(request, MAX_HTML_BYTES + 2048);
  if (!body.ok) return body;
  let html: unknown = body.value;
  let ttl = DEFAULT_TTL;
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const input = JSON.parse(body.value) as { html?: unknown; ttl_seconds?: unknown };
      html = input.html;
      ttl = clampTtl(input.ttl_seconds);
    } catch { return { ok: false, response: json({ error: "invalid_request" }, 400) }; }
  }
  const error = validateHtml(html);
  return error ? { ok: false, response: error } : { ok: true, html: html as string, ttl };
}

function validateHtml(html: unknown): Response | null {
  if (typeof html !== "string") return json({ error: "invalid_request", message: "html must be a string." }, 400);
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) return json({ error: "payload_too_large" }, 413);
  if (!/<(?:!doctype\s+html|html|body|section|article)\b/i.test(html.slice(0, 512))) {
    return json({ error: "invalid_request", message: "Upload must look like HTML." }, 400);
  }
  return null;
}

function injectNavigation(html: string, id: string, version: number, latest: number): string {
  const previous = version > 1 ? `<a href="/p/${id}/v/${version - 1}">← Previous</a>` : `<span class="plan-nav-disabled">← Previous</span>`;
  const next = version < latest ? `<a href="/p/${id}/v/${version + 1}">Next →</a>` : `<span class="plan-nav-disabled">Next →</span>`;
  const bar = `<style>${navigationCss()}</style><nav class="plan-revision-nav" aria-label="Plan revision navigation"><span>${previous}</span><strong>Version ${version} of ${latest}</strong><span>${next}<a href="/p/${id}">Latest</a><a href="/p/${id}/history">History</a></span></nav>`;
  return /<body(?:\s[^>]*)?>/i.test(html) ? html.replace(/<body(?:\s[^>]*)?>/i, (body) => body + bar) : bar + html;
}

function navigationCss(): string {
  return `.plan-revision-nav{box-sizing:border-box;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:18px;width:min(1120px,calc(100% - 32px));margin:16px auto;padding:14px 16px;color:#18201b;background:#fffdf7;border:1px solid #d8d4c8;border-top:5px solid #18201b;box-shadow:5px 5px 0 #b97913;font:16px/1.4 ui-sans-serif,system-ui,sans-serif}.plan-revision-nav span:last-child{display:flex;justify-content:flex-end;gap:14px}.plan-revision-nav strong{font:700 1.2rem/1 Georgia,serif}.plan-revision-nav a{color:#276c72;font-weight:800;text-decoration:none}.plan-revision-nav a:hover{text-decoration:underline}.plan-nav-disabled{color:#667168}@media(max-width:760px){.plan-revision-nav{grid-template-columns:1fr}.plan-revision-nav span:last-child{justify-content:flex-start;flex-wrap:wrap}}`;
}

function historyCss(): string {
  return `:root{--ink:#18201b;--muted:#667168;--paper:#f3f0e8;--card:#fffdf7;--line:#d8d4c8;--blue:#276c72}*{box-sizing:border-box}body{margin:0;color:var(--ink);background:var(--paper);font:16px/1.55 ui-sans-serif,system-ui,sans-serif}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.32;background-image:radial-gradient(#18201b .45px,transparent .45px);background-size:7px 7px}main{position:relative;width:min(880px,calc(100% - 32px));margin:32px auto 72px;border-top:8px solid var(--ink);padding-top:42px}.eyebrow{color:var(--blue);font-size:.75rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{margin:.3rem 0 .7rem;font:700 clamp(2.6rem,7vw,5.8rem)/.94 Georgia,serif;letter-spacing:-.045em}.lede{color:var(--muted)}a{color:var(--blue);font-weight:800;text-decoration:none}ol{list-style:none;padding:0;margin-top:32px}li{padding:22px;margin:12px 0;background:var(--card);border:1px solid var(--line)}li>a{font:700 1.4rem/1 Georgia,serif}time{float:right;color:var(--muted);font-size:.85rem}li p{margin:.6rem 0 0}@media(max-width:600px){time{float:none;display:block;margin-top:6px}}`;
}

async function authenticated(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const configured = (env.PLAN_HOST_TOKENS || env.PLAN_HOST_TOKEN || "").split(/[\s,]+/).filter(Boolean);
  if (!supplied || configured.length === 0) return false;
  const suppliedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const hashes = await Promise.all(configured.map((token) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
  return hashes.some((hash) => equalBytes(suppliedHash, hash));
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  const value = await env.PLANS.get(key, "text");
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function equalText(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clampTtl(value: unknown): number {
  const ttl = Number(value);
  return Number.isFinite(ttl) ? Math.min(DEFAULT_TTL, Math.max(MIN_TTL, Math.floor(ttl))) : DEFAULT_TTL;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function latestKey(id: string) { return `plan:${id}:latest`; }
function historyKey(id: string) { return `plan:${id}:history`; }
function versionKey(id: string, version: number) { return `plan:${id}:v:${version}`; }
function publicBaseUrl(env: Env, request: Request) { return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, ""); }

type BodyResult = { ok: true; value: string } | { ok: false; response: Response };

async function readBody(request: Request, limit: number): Promise<BodyResult> {
  if (Number(request.headers.get("content-length")) > limit) return { ok: false, response: json({ error: "payload_too_large" }, 413) };
  if (!request.body) return { ok: true, value: "" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let value = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return { ok: true, value: value + decoder.decode() };
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return { ok: false, response: json({ error: "payload_too_large" }, 413) };
    }
    value += decoder.decode(chunk.value, { stream: true });
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function unavailable(): Response {
  return new Response("<!doctype html><h1>Plan unavailable</h1><p>This plan has expired or does not exist.</p>", { status: 404, headers: PREVIEW_HEADERS });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

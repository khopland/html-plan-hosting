import { Hono } from "hono";

export interface Env {
  PLANS: KVNamespace;
  UPLOAD_RATE_LIMITER: DurableObjectNamespace;
  PLAN_HOST_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  DEFAULT_TTL_SECONDS?: string;
  MAX_TTL_SECONDS?: string;
  MAX_HTML_BYTES?: string;
  RATE_LIMIT_UPLOADS_PER_HOUR?: string;
  ALLOW_PUBLIC_INDEX?: string;
  API_HOSTNAME?: string;
  PREVIEW_HOSTNAME?: string;
}

interface PlanMetadata {
  id: string;
  title: string | null;
  createdAt: string;
  expiresAt: string;
  ttlSeconds: number;
  sha256: string;
  sizeBytes: number;
  contentType: "text/html";
  tokenHash: string;
}

interface JsonUpload {
  html?: unknown;
  title?: unknown;
  ttl_seconds?: unknown;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_HTML_BYTES = 1024 * 1024;
const DEFAULT_RATE_LIMIT_UPLOADS_PER_HOUR = 60;
const MIN_TTL_SECONDS = 60;
const ID_BYTES = 18;
const JSON_BODY_OVERHEAD_BYTES = 2048;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

const PREVIEW_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, max-age=60",
  "content-security-policy":
    "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "cross-origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400"
};

const app = new Hono<{ Bindings: Env }>();

app.options("*", () => new Response(null, { status: 204, headers: CORS_HEADERS }));

app.use("/v1/*", async (c, next) => {
  if (!isAllowedHostname(c.req.raw, c.env.API_HOSTNAME)) return json({ error: "not_found" }, 404);
  await next();
});

app.use("/p/*", async (c, next) => {
  if (!isAllowedHostname(c.req.raw, c.env.PREVIEW_HOSTNAME)) return previewError("Invalid plan URL.", 404);
  await next();
});

app.get("/", (c) => handleIndex(c.env));

app.post("/v1/plans", async (c) => withCors(await handleCreatePlan(c.req.raw, c.env)));

app.get("/v1/plans", async (c) => withCors(await handleListPlans(c.req.raw, c.env)));

app.get("/v1/plans/:id", async (c) => withCors(await handleGetPlan(c.req.param("id"), c.req.raw, c.env)));

app.delete("/v1/plans/:id", async (c) => withCors(await handleDeletePlan(c.req.param("id"), c.req.raw, c.env)));

app.get("/p/:id", async (c) => handlePreview(c.req.param("id"), c.env));

app.on("HEAD", "/p/:id", async (c) => handlePreview(c.req.param("id"), c.env, true));

app.notFound(() => json({ error: "not_found" }, 404));

app.onError((error, c) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  console.error(JSON.stringify({
    level: "error",
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    message: error instanceof Error ? error.message : "unknown_error"
  }));
  return json({ error: "internal_error", request_id: requestId }, 500);
});

export default app;

async function handleCreatePlan(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  const parsed = readConfig(env);
  let html: string;
  let title: string | null = null;
  let ttlSeconds = parsed.defaultTtlSeconds;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const bodyText = await readBodyWithLimit(request, parsed.maxHtmlBytes * 6 + JSON_BODY_OVERHEAD_BYTES);
    if (!bodyText.ok) return bodyText.response;
    const body = safeJson<JsonUpload>(bodyText.value);
    if (!body || typeof body.html !== "string") {
      return json({ error: "invalid_request", message: "JSON body must include an html string." }, 400);
    }

    html = body.html;
    title = typeof body.title === "string" ? cleanTitle(body.title) : null;
    ttlSeconds = parseRequestedTtl(body.ttl_seconds, parsed.defaultTtlSeconds, parsed.maxTtlSeconds);
  } else if (contentType.includes("text/html") || contentType === "") {
    const body = await readBodyWithLimit(request, parsed.maxHtmlBytes);
    if (!body.ok) return body.response;
    html = body.value;
    ttlSeconds = parseRequestedTtl(new URL(request.url).searchParams.get("ttl_seconds"), parsed.defaultTtlSeconds, parsed.maxTtlSeconds);
  } else {
    return json({ error: "unsupported_media_type", message: "Use text/html or application/json." }, 415);
  }

  const sizeBytes = new TextEncoder().encode(html).byteLength;
  if (sizeBytes === 0) {
    return json({ error: "invalid_request", message: "HTML body cannot be empty." }, 400);
  }

  if (sizeBytes > parsed.maxHtmlBytes) {
    return json(
      {
        error: "payload_too_large",
        message: `HTML is ${sizeBytes} bytes; max is ${parsed.maxHtmlBytes} bytes.`
      },
      413
    );
  }

  if (!looksLikeHtml(html)) {
    return json({ error: "invalid_request", message: "Upload must look like an HTML document." }, 400);
  }

  const rateLimit = await checkUploadRateLimit(env, auth.tokenHash, parsed.rateLimitUploadsPerHour);
  if (rateLimit) return rateLimit;

  const id = createId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const sha256 = await digestSha256(html);
  const metadata: PlanMetadata = {
    id,
    title,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ttlSeconds,
    sha256,
    sizeBytes,
    contentType: "text/html",
    tokenHash: auth.tokenHash
  };

  await env.PLANS.put(htmlKey(id), html, {
    expirationTtl: ttlSeconds,
    metadata: { sha256, sizeBytes }
  });
  await env.PLANS.put(metaKey(id), JSON.stringify(metadata), {
    expirationTtl: ttlSeconds,
    metadata: { expiresAt: metadata.expiresAt }
  });

  logEvent("plan_created", { id, tokenHash: auth.tokenHash, sizeBytes, ttlSeconds });

  const publicBaseUrl = getPublicBaseUrl(env, request);
  return json(
    {
      id,
      url: `${publicBaseUrl}/p/${id}`,
      metadata_url: `${publicBaseUrl}/v1/plans/${id}`,
      expires_at: metadata.expiresAt,
      sha256
    },
    201
  );
}

async function handlePreview(id: string, env: Env, headOnly = false): Promise<Response> {
  if (!isValidId(id)) {
    return previewError("Invalid plan URL.", 404);
  }

  const metadata = await getMetadata(id, env);
  if (!metadata || isExpired(metadata)) {
    return previewError("This plan is not available or has expired.", 404);
  }

  const html = await env.PLANS.get(htmlKey(id), "text");
  if (!html) {
    return previewError("This plan is not available or has expired.", 404);
  }

  return new Response(headOnly ? null : html, {
    status: 200,
    headers: PREVIEW_HEADERS
  });
}

async function handleGetPlan(id: string, request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  if (!isValidId(id)) {
    return json({ error: "not_found" }, 404);
  }

  const metadata = await getMetadata(id, env);
  if (!metadata || isExpired(metadata)) {
    return json({ error: "not_found" }, 404);
  }

  return json(metadata);
}

async function handleDeletePlan(id: string, request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  if (!isValidId(id)) {
    return json({ error: "not_found" }, 404);
  }

  await Promise.all([env.PLANS.delete(htmlKey(id)), env.PLANS.delete(metaKey(id))]);
  logEvent("plan_deleted", { id, tokenHash: auth.tokenHash });
  return json({ deleted: true, id });
}

async function handleListPlans(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return auth.response;
  }

  const url = new URL(request.url);
  const limit = clampInteger(url.searchParams.get("limit") ?? undefined, 1, 100, 25);
  const cursor = url.searchParams.get("cursor") || undefined;
  const listed = await env.PLANS.list({ prefix: "plan:", cursor, limit: limit * 2 });
  const metaKeys = listed.keys.filter((key) => key.name.endsWith(":meta")).slice(0, limit);
  const plans = (
    await Promise.all(
      metaKeys.map(async (key) => {
        const id = key.name.slice("plan:".length, -":meta".length);
        const metadata = await getMetadata(id, env);
        return metadata && !isExpired(metadata) ? metadata : null;
      })
    )
  ).filter((metadata): metadata is PlanMetadata => metadata !== null);

  return json({
    plans,
    cursor: listed.list_complete ? null : listed.cursor
  });
}

function handleIndex(env: Env): Response {
  if (env.ALLOW_PUBLIC_INDEX !== "true") {
    return json({ service: "agent-html-plan-host", ok: true });
  }

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent HTML Plan Host</title></head><body><h1>Agent HTML Plan Host</h1><p>POST HTML to /v1/plans with an Authorization bearer token.</p></body></html>`,
    { headers: PREVIEW_HEADERS }
  );
}

type AuthResult =
  | { ok: true; tokenHash: string }
  | { ok: false; response: Response };

async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  if (!env.PLAN_HOST_TOKEN) {
    return { ok: false, response: json({ error: "server_misconfigured", message: "PLAN_HOST_TOKEN secret is not set." }, 500) };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  const token = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : "";
  if (!(await timingSafeEqual(token, env.PLAN_HOST_TOKEN))) {
    return { ok: false, response: json({ error: "unauthorized" }, 401) };
  }

  return { ok: true, tokenHash: (await digestSha256(token)).slice(0, 16) };
}

function readConfig(env: Env) {
  const maxTtlSeconds = clampInteger(env.MAX_TTL_SECONDS, MIN_TTL_SECONDS, MAX_TTL_SECONDS, MAX_TTL_SECONDS);
  const defaultTtlFallback = Math.min(DEFAULT_TTL_SECONDS, maxTtlSeconds);
  return {
    defaultTtlSeconds: clampInteger(env.DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS, maxTtlSeconds, defaultTtlFallback),
    maxTtlSeconds,
    maxHtmlBytes: clampInteger(env.MAX_HTML_BYTES, 1, MAX_HTML_BYTES, MAX_HTML_BYTES),
    rateLimitUploadsPerHour: clampInteger(env.RATE_LIMIT_UPLOADS_PER_HOUR, 0, 1000, DEFAULT_RATE_LIMIT_UPLOADS_PER_HOUR)
  };
}

async function checkUploadRateLimit(env: Env, tokenHash: string, limit: number): Promise<Response | null> {
  if (limit <= 0) {
    return null;
  }

  const now = new Date();
  const stub = env.UPLOAD_RATE_LIMITER.get(env.UPLOAD_RATE_LIMITER.idFromName(tokenHash));
  const result = await stub.fetch("https://rate-limiter.internal/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bucket: now.toISOString().slice(0, 13), limit })
  });
  if (!result.ok) {
    logEvent("upload_rate_limited", { tokenHash, limit, retryAfterSeconds: secondsUntilNextHour(now) });
    return json(
      {
        error: "rate_limited",
        message: `Upload limit of ${limit} per hour reached.`,
        retry_after_seconds: secondsUntilNextHour(now)
      },
      429
    );
  }

  return null;
}

function parseRequestedTtl(value: unknown, defaultTtlSeconds: number, maxTtlSeconds: number): number {
  if (value === undefined || value === null || value === "") {
    return defaultTtlSeconds;
  }

  const ttl = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ttl)) {
    return defaultTtlSeconds;
  }

  return Math.min(Math.max(Math.floor(ttl), MIN_TTL_SECONDS), maxTtlSeconds);
}

function clampInteger(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function secondsUntilNextHour(now: Date): number {
  const next = new Date(now);
  next.setUTCMinutes(60, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

function safeJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

type BodyReadResult = { ok: true; value: string } | { ok: false; response: Response };

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, response: payloadTooLarge(maxBytes) };
  }
  if (!request.body) return { ok: true, value: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { ok: true, value: text + decoder.decode() };
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel("payload_too_large");
      return { ok: false, response: payloadTooLarge(maxBytes) };
    }
    text += decoder.decode(value, { stream: true });
  }
}

function payloadTooLarge(maxBytes: number): Response {
  return json({ error: "payload_too_large", message: `Request body exceeds the ${maxBytes} byte limit.` }, 413);
}

interface RateLimitState { bucket: string; count: number }

export class UploadRateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const input = safeJson<{ bucket?: unknown; limit?: unknown }>(await request.text());
    if (!input || typeof input.bucket !== "string" || typeof input.limit !== "number") {
      return new Response(null, { status: 400 });
    }
    const { bucket, limit } = input as { bucket: string; limit: number };
    const allowed = await this.state.storage.transaction(async (storage) => {
      const current = await storage.get<RateLimitState>("window");
      const count = current?.bucket === bucket ? current.count : 0;
      if (count >= limit) return false;
      await storage.put("window", { bucket, count: count + 1 });
      return true;
    });
    return new Response(null, { status: allowed ? 204 : 429 });
  }
}

function htmlKey(id: string): string {
  return `plan:${id}:html`;
}

function metaKey(id: string): string {
  return `plan:${id}:meta`;
}

function createId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(id);
}

function cleanTitle(title: string): string | null {
  const cleaned = title.replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned.length ? cleaned : null;
}

function looksLikeHtml(html: string): boolean {
  const sample = html.slice(0, 512).toLowerCase();
  return sample.includes("<!doctype html") || sample.includes("<html") || sample.includes("<body") || sample.includes("<section") || sample.includes("<article");
}

async function digestSha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const left = await crypto.subtle.digest("SHA-256", encoder.encode(a));
  const right = await crypto.subtle.digest("SHA-256", encoder.encode(b));
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);

  let diff = leftBytes.length ^ rightBytes.length;
  for (let i = 0; i < Math.max(leftBytes.length, rightBytes.length); i += 1) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return diff === 0 && a.length === b.length;
}

async function getMetadata(id: string, env: Env): Promise<PlanMetadata | null> {
  const raw = await env.PLANS.get(metaKey(id), "text");
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PlanMetadata;
  } catch {
    return null;
  }
}

function isExpired(metadata: PlanMetadata): boolean {
  return Date.parse(metadata.expiresAt) <= Date.now();
}

function getPublicBaseUrl(env: Env, request: Request): string {
  const configured = env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (configured) {
    return configured;
  }

  const url = new URL(request.url);
  return url.origin;
}

function isAllowedHostname(request: Request, configuredHostname: string | undefined): boolean {
  return !configuredHostname || new URL(request.url).hostname === configuredHostname.toLowerCase();
}

function logEvent(event: string, fields: Record<string, string | number | boolean | null>): void {
  console.info(JSON.stringify({ level: "info", event, ...fields }));
}

function previewError(message: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan unavailable</title></head><body><h1>Plan unavailable</h1><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: PREVIEW_HEADERS }
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

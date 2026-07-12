export interface Env {
  PLANS: KVNamespace;
  PLAN_HOST_TOKENS?: string;
  PLAN_HOST_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
}

const DEFAULT_TTL = 7 * 24 * 60 * 60;
const MIN_TTL = 60;
const MAX_HTML_BYTES = 1024 * 1024;
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

  const body = await readBody(request, MAX_HTML_BYTES + 2048);
  if (!body.ok) return body.response;

  let html = body.value;
  let ttl = DEFAULT_TTL;
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const input = JSON.parse(body.value) as { html?: unknown; ttl_seconds?: unknown };
      if (typeof input.html !== "string") throw new Error();
      html = input.html;
      ttl = clampTtl(input.ttl_seconds);
    } catch {
      return json({ error: "invalid_request", message: "JSON body must include an html string." }, 400);
    }
  }

  const size = new TextEncoder().encode(html).byteLength;
  if (size > MAX_HTML_BYTES) return json({ error: "payload_too_large" }, 413);
  if (!/<(?:!doctype\s+html|html|body|section|article)\b/i.test(html.slice(0, 512))) {
    return json({ error: "invalid_request", message: "Upload must look like HTML." }, 400);
  }

  const id = randomId();
  await env.PLANS.put(id, html, { expirationTtl: ttl });
  const baseUrl = (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
  return json({
    id,
    url: `${baseUrl}/p/${id}`,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString()
  }, 201);
}

async function preview(id: string, env: Env, head: boolean): Promise<Response> {
  const html = ID_PATTERN.test(id) ? await env.PLANS.get(id, "text") : null;
  if (!html) {
    return new Response("<!doctype html><h1>Plan unavailable</h1><p>This plan has expired or does not exist.</p>", {
      status: 404,
      headers: PREVIEW_HEADERS
    });
  }
  return new Response(head ? null : html, { headers: PREVIEW_HEADERS });
}

async function authenticated(request: Request, env: Env): Promise<boolean> {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const configured = (env.PLAN_HOST_TOKENS || env.PLAN_HOST_TOKEN || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!supplied || configured.length === 0) return false;
  const suppliedHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const hashes = await Promise.all(configured.map((token) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  ));
  return hashes.some((hash) => equalBytes(suppliedHash, hash));
}

function equalBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function clampTtl(value: unknown): number {
  const ttl = Number(value);
  return Number.isFinite(ttl) ? Math.min(DEFAULT_TTL, Math.max(MIN_TTL, Math.floor(ttl))) : DEFAULT_TTL;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

type BodyResult = { ok: true; value: string } | { ok: false; response: Response };

async function readBody(request: Request, limit: number): Promise<BodyResult> {
  if (Number(request.headers.get("content-length")) > limit) {
    return { ok: false, response: json({ error: "payload_too_large" }, 413) };
  }
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

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
}

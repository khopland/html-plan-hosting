import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";

class MemoryKV {
  private values = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }

    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<KVNamespaceListResult<unknown, string>> {
    const keys = [...this.values.keys()]
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .sort()
      .slice(0, options?.limit ?? 1000)
      .map((name) => ({ name }));

    return {
      keys,
      list_complete: true,
      cacheStatus: null
    };
  }
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    PLANS: new MemoryKV() as unknown as KVNamespace,
    PLAN_HOST_TOKEN: "test-token",
    PUBLIC_BASE_URL: "https://plans.example.test",
    DEFAULT_TTL_SECONDS: "3600",
    MAX_TTL_SECONDS: "86400",
    MAX_HTML_BYTES: "2000",
    RATE_LIMIT_UPLOADS_PER_HOUR: "60",
    ...overrides
  };
}

async function fetchWorker(request: Request, env = createEnv()): Promise<Response> {
  return worker.fetch(request, env);
}

describe("agent html plan host", () => {
  it("rejects uploads without a bearer token", async () => {
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: { "content-type": "text/html" },
        body: "<!doctype html><html><body>Plan</body></html>"
      })
    );

    expect(response.status).toBe(401);
  });

  it("uploads html and returns a preview url", async () => {
    const env = createEnv();
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/html"
        },
        body: "<!doctype html><html><body><h1>Deployment Plan</h1></body></html>"
      }),
      env
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; url: string; sha256: string };
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(body.url).toBe(`https://plans.example.test/p/${body.id}`);
    expect(body.sha256).toHaveLength(64);
  });

  it("serves uploaded html with locked-down preview headers", async () => {
    const env = createEnv();
    const upload = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          title: "Test",
          ttl_seconds: 300,
          html: "<!doctype html><html><body><script>alert(1)</script><h1>Plan</h1></body></html>"
        })
      }),
      env
    );
    const created = (await upload.json()) as { url: string };

    const preview = await fetchWorker(new Request(created.url), env);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("<script>alert(1)</script>");
    expect(preview.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("supports HEAD for preview header checks", async () => {
    const env = createEnv();
    const upload = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/html"
        },
        body: "<!doctype html><html><body><h1>Head check</h1></body></html>"
      }),
      env
    );
    const created = (await upload.json()) as { url: string };

    const preview = await fetchWorker(new Request(created.url, { method: "HEAD" }), env);

    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await preview.text()).toBe("");
  });

  it("returns metadata for authenticated callers", async () => {
    const env = createEnv();
    const upload = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          title: "Metadata plan",
          html: "<!doctype html><html><body><h1>Plan</h1></body></html>"
        })
      }),
      env
    );
    const created = (await upload.json()) as { id: string };

    const metadata = await fetchWorker(
      new Request(`https://api.example.test/v1/plans/${created.id}`, {
        headers: { authorization: "Bearer test-token" }
      }),
      env
    );
    const body = (await metadata.json()) as { title: string; sizeBytes: number };

    expect(metadata.status).toBe(200);
    expect(body.title).toBe("Metadata plan");
    expect(body.sizeBytes).toBeGreaterThan(0);
  });

  it("lists stored plans for authenticated callers", async () => {
    const env = createEnv();
    await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          title: "Listed plan",
          html: "<!doctype html><html><body><h1>Plan</h1></body></html>"
        })
      }),
      env
    );

    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        headers: { authorization: "Bearer test-token" }
      }),
      env
    );
    const body = (await response.json()) as { plans: Array<{ title: string }> };

    expect(response.status).toBe(200);
    expect(body.plans).toHaveLength(1);
    expect(body.plans[0].title).toBe("Listed plan");
  });

  it("deletes a plan", async () => {
    const env = createEnv();
    const upload = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/html"
        },
        body: "<!doctype html><html><body>Delete me</body></html>"
      }),
      env
    );
    const created = (await upload.json()) as { id: string; url: string };

    const deleted = await fetchWorker(
      new Request(`https://api.example.test/v1/plans/${created.id}`, {
        method: "DELETE",
        headers: { authorization: "Bearer test-token" }
      }),
      env
    );
    const preview = await fetchWorker(new Request(created.url), env);

    expect(deleted.status).toBe(200);
    expect(preview.status).toBe(404);
  });

  it("rejects oversized html", async () => {
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/html"
        },
        body: `<!doctype html><html><body>${"x".repeat(2100)}</body></html>`
      })
    );

    expect(response.status).toBe(413);
  });

  it("rate limits uploads by token hash", async () => {
    const env = createEnv({ RATE_LIMIT_UPLOADS_PER_HOUR: "1" });
    const request = () =>
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/html"
        },
        body: "<!doctype html><html><body>Limited</body></html>"
      });

    const first = await fetchWorker(request(), env);
    const second = await fetchWorker(request(), env);

    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });
});

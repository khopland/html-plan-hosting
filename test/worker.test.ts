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

class MemoryRateLimiterNamespace {
  private counts = new Map<string, { bucket: string; count: number }>();

  idFromName(name: string): DurableObjectId {
    return name as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const key = id as unknown as string;
    return {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body)) as { bucket: string; limit: number };
        const current = this.counts.get(key);
        const count = current?.bucket === input.bucket ? current.count : 0;
        if (count >= input.limit) return new Response(null, { status: 429 });
        this.counts.set(key, { bucket: input.bucket, count: count + 1 });
        return new Response(null, { status: 204 });
      }
    } as unknown as DurableObjectStub;
  }
}

class MemoryMetrics {
  points: AnalyticsEngineDataPoint[] = [];

  writeDataPoint(point: AnalyticsEngineDataPoint): void {
    this.points.push(point);
  }
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    PLANS: new MemoryKV() as unknown as KVNamespace,
    UPLOAD_RATE_LIMITER: new MemoryRateLimiterNamespace() as unknown as DurableObjectNamespace,
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

  it("records lifecycle and rate-limit metrics", async () => {
    const metrics = new MemoryMetrics();
    const env = createEnv({
      RATE_LIMIT_UPLOADS_PER_HOUR: "1",
      PLAN_METRICS: metrics as unknown as AnalyticsEngineDataset
    });
    const request = () => new Request("https://api.example.test/v1/plans", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "text/html" },
      body: "<!doctype html><html><body>Measured</body></html>"
    });

    expect((await fetchWorker(request(), env)).status).toBe(201);
    expect((await fetchWorker(request(), env)).status).toBe(429);
    expect(metrics.points.map((point) => point.blobs?.[0])).toEqual(["plan_created", "upload_rate_limited"]);
  });

  it("does not consume quota for rejected uploads", async () => {
    const env = createEnv({ RATE_LIMIT_UPLOADS_PER_HOUR: "1" });
    const upload = (body: string) => fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "text/html" },
        body
      }),
      env
    );

    expect((await upload("not html")).status).toBe(400);
    expect((await upload("<!doctype html><html><body>Valid</body></html>")).status).toBe(201);
    expect((await upload("<!doctype html><html><body>Over quota</body></html>")).status).toBe(429);
  });

  it("stops reading raw html after the configured byte limit", async () => {
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "text/html" },
        body: `<!doctype html><html><body>${"x".repeat(2100)}</body></html>`
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "payload_too_large",
      message: "Request body exceeds the 2000 byte limit."
    });
  });

  it("rejects an oversized declared content length before reading the body", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("<!doctype html><html><body>Plan</body></html>"));
        controller.close();
      }
    });
    const request = new Request("https://api.example.test/v1/plans", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "text/html",
        "content-length": "2001"
      },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    const response = await fetchWorker(request);

    expect(response.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  it("enforces the byte limit on chunked bodies without content length", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode("<!doctype html><html><body>"),
      encoder.encode("x".repeat(2000)),
      encoder.encode("</body></html>")
    ];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      }
    });
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "text/html" },
        body,
        duplex: "half"
      } as RequestInit & { duplex: "half" })
    );

    expect(response.status).toBe(413);
  });

  it("keeps the default ttl within a lower configured maximum", async () => {
    const env = createEnv({ DEFAULT_TTL_SECONDS: undefined, MAX_TTL_SECONDS: "120" });
    const before = Date.now();
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "text/html"
        },
        body: "<!doctype html><html><body>Short lived</body></html>"
      }),
      env
    );
    const body = (await response.json()) as { expires_at: string };

    expect(response.status).toBe(201);
    expect(Date.parse(body.expires_at) - before).toBeGreaterThan(119_000);
    expect(Date.parse(body.expires_at) - before).toBeLessThan(121_000);
  });

  it.each([
    { name: "invalid default", defaultTtl: "invalid", maxTtl: "120", expected: 120 },
    { name: "default below minimum", defaultTtl: "1", maxTtl: "120", expected: 60 },
    { name: "default above maximum", defaultTtl: "999", maxTtl: "120", expected: 120 }
  ])("normalizes $name", async ({ defaultTtl, maxTtl, expected }) => {
    const env = createEnv({ DEFAULT_TTL_SECONDS: defaultTtl, MAX_TTL_SECONDS: maxTtl });
    const before = Date.now();
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans", {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "text/html" },
        body: "<!doctype html><html><body>TTL matrix</body></html>"
      }),
      env
    );
    const body = (await response.json()) as { expires_at: string };
    const actual = Date.parse(body.expires_at) - before;

    expect(response.status).toBe(201);
    expect(actual).toBeGreaterThan((expected - 1) * 1000);
    expect(actual).toBeLessThan((expected + 1) * 1000);
  });

  it("does not expose internal exception messages", async () => {
    const env = createEnv({
      PLANS: {
        get: async () => {
          throw new Error("sensitive storage detail");
        }
      } as unknown as KVNamespace
    });
    const response = await fetchWorker(
      new Request("https://api.example.test/v1/plans/abcdefghijklmnopqrst", {
        headers: { authorization: "Bearer test-token", "cf-ray": "test-request-id" }
      }),
      env
    );
    const body = (await response.json()) as { error: string; request_id: string; message?: string };

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "internal_error", request_id: "test-request-id" });
    expect(body.message).toBeUndefined();
  });
});

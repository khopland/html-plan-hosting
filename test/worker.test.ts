import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/worker";

class MemoryKV {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, value: string) { this.values.set(key, value); }
}

function env(tokens = "laptop,phone"): Env {
  return { PLANS: new MemoryKV() as unknown as KVNamespace, PLAN_HOST_TOKENS: tokens, PUBLIC_BASE_URL: "https://plans.test" };
}

function upload(token: string, environment: Env) {
  return worker.fetch(new Request("https://api.test/v1/plans", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/html" },
    body: "<!doctype html><html><body>Plan</body></html>"
  }), environment);
}

describe("html plan host", () => {
  it("accepts each configured secret and rejects other secrets", async () => {
    expect((await upload("laptop", env())).status).toBe(201);
    expect((await upload("phone", env())).status).toBe(201);
    expect((await upload("wrong", env())).status).toBe(401);
  });

  it("keeps the old single-secret setting working", async () => {
    const environment = env("");
    environment.PLAN_HOST_TOKEN = "old-secret";
    expect((await upload("old-secret", environment)).status).toBe(201);
  });

  it("uploads and serves locked-down HTML", async () => {
    const environment = env();
    const response = await upload("laptop", environment);
    const created = await response.json() as { url: string };
    const preview = await worker.fetch(new Request(created.url), environment);
    expect(response.status).toBe(201);
    expect(await preview.text()).toContain("Plan");
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("rejects invalid and oversized uploads", async () => {
    const environment = env();
    const invalid = await worker.fetch(new Request("https://api.test/v1/plans", {
      method: "POST",
      headers: { authorization: "Bearer laptop", "content-type": "text/html" },
      body: "not html"
    }), environment);
    const oversized = await worker.fetch(new Request("https://api.test/v1/plans", {
      method: "POST",
      headers: { authorization: "Bearer laptop", "content-type": "text/html", "content-length": "2000000" },
      body: "<!doctype html>"
    }), environment);
    expect(invalid.status).toBe(400);
    expect(oversized.status).toBe(413);
  });
});

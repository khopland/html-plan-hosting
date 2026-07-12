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

  it("updates a plan while keeping old versions navigable", async () => {
    const environment = env();
    const createdResponse = await upload("laptop", environment);
    const created = await createdResponse.json() as { id: string; url: string; update_token: string };
    const updatedResponse = await worker.fetch(new Request(`https://api.test/v1/plans/${created.id}`, {
      method: "POST",
      headers: { authorization: "Bearer laptop", "content-type": "application/json" },
      body: JSON.stringify({
        html: "<!doctype html><html><body>Updated plan</body></html>",
        update_token: created.update_token,
        change_summary: "Added the rollout steps"
      })
    }), environment);
    const updated = await updatedResponse.json() as { version: number };
    const latest = await worker.fetch(new Request(created.url), environment);
    const first = await worker.fetch(new Request(`${created.url}/v/1`), environment);
    const history = await worker.fetch(new Request(`${created.url}/history`), environment);
    const latestHtml = await latest.text();
    const firstHtml = await first.text();
    const historyHtml = await history.text();

    expect(updated).toEqual(expect.objectContaining({ version: 2 }));
    expect(latestHtml).toContain("Updated plan");
    expect(latestHtml).toContain("Version 2 of 2");
    expect(latestHtml).toContain(`/p/${created.id}/v/1`);
    expect(latestHtml).toContain("History");
    expect(firstHtml).toContain("Plan</body>");
    expect(firstHtml).not.toContain("Updated plan");
    expect(historyHtml).toContain("Added the rollout steps");
    expect(historyHtml).toContain("Version 1");
  });

  it("rejects updates with the wrong update token", async () => {
    const environment = env();
    const created = await (await upload("laptop", environment)).json() as { id: string };
    const response = await worker.fetch(new Request(`https://api.test/v1/plans/${created.id}`, {
      method: "POST",
      headers: { authorization: "Bearer laptop", "content-type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><html><body>Bad update</body></html>", update_token: "wrong", change_summary: "Bad" })
    }), environment);
    expect(response.status).toBe(403);
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

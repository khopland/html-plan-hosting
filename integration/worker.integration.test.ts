import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const authorization = { authorization: "Bearer integration-token" };

function upload(body: string): Promise<Response> {
  return exports.default.fetch("https://api.example.test/v1/plans", {
    method: "POST",
    headers: { ...authorization, "content-type": "text/html" },
    body
  });
}

describe("Worker runtime integration", () => {
  it("enforces the Durable Object quota under concurrent uploads", async () => {
    const responses = await Promise.all([
      upload("<!doctype html><html><body>One</body></html>"),
      upload("<!doctype html><html><body>Two</body></html>"),
      upload("<!doctype html><html><body>Three</body></html>")
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201, 429]);
  });

  it("handles malformed JSON and unsupported media types", async () => {
    const malformed = await exports.default.fetch("https://api.example.test/v1/plans", {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{"
    });
    const unsupported = await exports.default.fetch("https://api.example.test/v1/plans", {
      method: "POST",
      headers: { ...authorization, "content-type": "text/plain" },
      body: "hello"
    });

    expect(malformed.status).toBe(400);
    expect(unsupported.status).toBe(415);
  });

  it("returns CORS policy and rejects invalid IDs", async () => {
    const preflight = await exports.default.fetch("https://api.example.test/v1/plans", { method: "OPTIONS" });
    const invalid = await exports.default.fetch("https://api.example.test/v1/plans/not-valid", { headers: authorization });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(invalid.status).toBe(404);
  });

  it("isolates API and preview routes by hostname", async () => {
    const apiOnPreviewHost = await exports.default.fetch("https://plans.example.test/v1/plans", { headers: authorization });
    const previewOnApiHost = await exports.default.fetch("https://api.example.test/p/abcdefghijklmnopqrstuvwx");

    expect(apiOnPreviewHost.status).toBe(404);
    expect(previewOnApiHost.status).toBe(404);
  });

  it("treats partially missing and expired KV records as unavailable", async () => {
    const partialId = "abcdefghijklmnopqrstuvwx";
    await env.PLANS.put(`plan:${partialId}:html`, "<!doctype html><html><body>orphan</body></html>");
    const partial = await exports.default.fetch(`https://plans.example.test/p/${partialId}`);

    const expiredId = "zyxwvutsrqponmlkjihgfedc";
    await env.PLANS.put(`plan:${expiredId}:html`, "<!doctype html><html><body>expired</body></html>");
    await env.PLANS.put(`plan:${expiredId}:meta`, JSON.stringify({ expiresAt: "2000-01-01T00:00:00.000Z" }));
    const expired = await exports.default.fetch(`https://plans.example.test/p/${expiredId}`);

    expect(partial.status).toBe(404);
    expect(expired.status).toBe(404);
  });
});

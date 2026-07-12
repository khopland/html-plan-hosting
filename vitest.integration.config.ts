import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PLAN_HOST_TOKEN: "integration-token",
          PUBLIC_BASE_URL: "https://plans.example.test",
          RATE_LIMIT_UPLOADS_PER_HOUR: "2"
        }
      }
    })
  ],
  test: { include: ["integration/**/*.test.ts"] }
});

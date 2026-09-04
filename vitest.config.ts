import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { MOD_KEY: "test-mod-key", IP_SALT: "test-salt", PUBLIC_URL: "https://gradient.wiki", INBOX_TO: "owner@example.com" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});

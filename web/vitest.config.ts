import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  // compatibilityDate pinned: without it the pool's runner worker defaults to
  // "today", which breaks once today passes the pinned workerd binary's max date.
  plugins: [cloudflareTest({ configPath: "./wrangler.toml", environment: "dev", miniflare: { compatibilityDate: "2025-04-01" } })],
  test: {
    globals: true,
  },
});

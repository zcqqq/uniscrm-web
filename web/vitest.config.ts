import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  // compatibilityDate pinned: without it the pool's runner worker defaults to
  // "today", which breaks once today passes the pinned workerd binary's max date.
  // d1Databases: this pool setup doesn't surface wrangler.toml bindings into `env` from
  // cloudflare:test (verified empirically — env only carries the pool's own services), so the
  // WEB_DB binding tests/unit/shared-auth.test.ts needs is declared here. Purely additive:
  // it's an isolated local D1, and no other web test reads env bindings.
  plugins: [cloudflareTest({ configPath: "./wrangler.toml", environment: "dev", miniflare: { compatibilityDate: "2025-04-01", d1Databases: ["WEB_DB"] } })],
  test: {
    globals: true,
  },
});

import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml", environment: "dev" } })],
  test: {
    globals: true,
    exclude: ["**/node_modules/**"],
  },
});

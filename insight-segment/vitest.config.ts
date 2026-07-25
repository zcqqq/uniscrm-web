// Plain node environment, not @cloudflare/vitest-pool-workers: sql-builder.test.ts exercises
// pure string-building functions (buildSegmentQuery, fields.ts) with no D1/AI/R2 runtime
// binding involved, so there's nothing here that needs a Workers-shaped test pool. Without this
// file, vitest fell back to vite.config.ts's `root: "./frontend"` and found zero test files
// (tests/ lives at the module root, not under frontend/) — this file is what makes
// `npx vitest run` discover tests/*.test.ts at all.
//
// Not importing from "vitest/config" (unlike sibling modules' vitest.config.ts): this module
// has no local `vitest` install — `npx vitest run` resolves an ephemeral copy per invocation —
// so `import { defineConfig } from "vitest/config"` fails to resolve at config-load time. A
// plain object is all vitest's config loader needs; defineConfig is only a typing convenience.
export default {
  test: {
    globals: true,
    exclude: ["**/node_modules/**", "tests/e2e/**"],
  },
};

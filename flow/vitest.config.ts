import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml", environment: "dev" } })],
  // 测试里的 JSX 走 automatic runtime，与 tsconfig 的 "jsx": "react-jsx" 和生产构建
  // （vite 的 @vitejs/plugin-react）一致。不设的话 esbuild 默认转成 React.createElement，
  // 而组件源码按 automatic runtime 写、没有 import React —— 一执行就 "React is not defined"。
  esbuild: { jsx: "automatic" },
  test: {
    globals: true,
    exclude: ["**/node_modules/**", "tests/e2e/**"],
  },
});

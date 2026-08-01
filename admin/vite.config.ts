import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "./frontend",
  // 页面挂在 /tms 下，产物里的资源引用必须带这个前缀。
  base: "/tms/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  // build 的 root 是 ./frontend，但测试在 admin/tests/ 下 —— 不覆盖的话 vitest
  // 会把 frontend/ 当测试根目录，直接报 "No test files found"。
  // tests/e2e/ 是 Playwright 用例（CI 里由 npx playwright test 跑），被 vitest
  // 收集会因为 @playwright/test 的 test() 而加载失败。与 link/vitest.config.ts 同样处理。
  test: { root: ".", exclude: ["**/node_modules/**", "tests/e2e/**"] },
});

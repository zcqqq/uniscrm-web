import { defineConfig } from "vite";
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
});

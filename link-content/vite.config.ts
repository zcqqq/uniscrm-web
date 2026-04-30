import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "./frontend",
  envDir: "..",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api/auth": "http://localhost:8788",
      "/api/settings": "http://localhost:8788",
      "/api/recommendations": "http://localhost:8788",
      "/api": "http://localhost:8789",
    },
  },
});

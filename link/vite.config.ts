import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "./frontend",
  envDir: "../..",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8790",
      "/channel": "http://localhost:8790",
      "/x": "http://localhost:8790",
      "/internal": "http://localhost:8790",
    },
  },
});

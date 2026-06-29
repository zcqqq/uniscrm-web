import { defineConfig, devices } from "@playwright/test";

const ENV = process.env.E2E_ENV || "dev";
const SUFFIX = ENV === "production" ? "" : `-${ENV}`;

export default defineConfig({
  testDir: "..",
  testMatch: "**/tests/e2e/*.spec.ts",
  fullyParallel: true,
  retries: 1,
  reporter: [["html", { open: "never" }]],
  use: {
    storageState: "e2e/storage-state.json",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "web",
      use: { ...devices["Desktop Chrome"], baseURL: `https://web${SUFFIX}.uni-scrm.com` },
      testDir: "../web/tests/e2e",
    },
    {
      name: "link",
      use: { ...devices["Desktop Chrome"], baseURL: `https://link${SUFFIX}.uni-scrm.com` },
      testDir: "../link/tests/e2e",
    },
    {
      name: "flow",
      use: { ...devices["Desktop Chrome"], baseURL: `https://flow${SUFFIX}.uni-scrm.com` },
      testDir: "../flow/tests/e2e",
    },
    {
      name: "admin",
      use: { ...devices["Desktop Chrome"], baseURL: `https://admin${SUFFIX}.uni-scrm.com` },
      testDir: "../admin/tests/e2e",
    },
    {
      name: "analytics",
      use: { ...devices["Desktop Chrome"], baseURL: `https://analytics${SUFFIX}.uni-scrm.com` },
      testDir: "../analytics/tests/e2e",
    },
    {
      name: "insight-segment",
      use: { ...devices["Desktop Chrome"], baseURL: `https://insight-segment${SUFFIX}.uni-scrm.com` },
      testDir: "../insight-segment/tests/e2e",
    },
    {
      name: "profile",
      use: { ...devices["Desktop Chrome"], baseURL: `https://profile${SUFFIX}.uni-scrm.com` },
      testDir: "../profile/tests/e2e",
    },
  ],
  globalSetup: "./global-setup.ts",
});

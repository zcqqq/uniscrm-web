import { test, expect } from "@playwright/test";

test("GET /api/auth/me returns authenticated user", async ({ request }) => {
  const res = await request.get("/api/auth/me");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data.member).toBeDefined();
  expect(data.member.email).toBe("e2e-test@uni-scrm.com");
  expect(data.tenant).toBeDefined();
});

test("dashboard page loads without error", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveTitle(/error/i);
  expect(page.url()).not.toContain("/auth");
});

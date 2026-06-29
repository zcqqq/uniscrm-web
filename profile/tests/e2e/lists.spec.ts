import { test, expect } from "@playwright/test";

test("profile page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveTitle(/error/i);
});

test("GET /api/lists returns list", async ({ request }) => {
  const res = await request.get("/api/lists");
  expect(res.status()).toBe(200);
});

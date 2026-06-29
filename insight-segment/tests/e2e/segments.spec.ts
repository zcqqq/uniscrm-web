import { test, expect } from "@playwright/test";

test("segments page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveTitle(/error/i);
});

test("GET /api/segments returns list", async ({ request }) => {
  const res = await request.get("/api/segments");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty("segments");
});

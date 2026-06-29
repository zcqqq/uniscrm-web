import { test, expect } from "@playwright/test";

test("segments page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveTitle(/error/i);
});

test("GET /api/segments responds (auth may redirect)", async ({ request }) => {
  const res = await request.get("/api/segments");
  expect(res.status()).not.toBe(500);
});

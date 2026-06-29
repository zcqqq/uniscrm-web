import { test, expect } from "@playwright/test";

test("analytics page loads without 500", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).not.toBe(500);
  await expect(page).not.toHaveTitle(/error/i);
});

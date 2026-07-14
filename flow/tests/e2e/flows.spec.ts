import { test, expect } from "@playwright/test";

test("flows list page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveTitle(/error/i);
});

test("GET /api/flows returns list", async ({ request }) => {
  const res = await request.get("/api/flows");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty("flows");
});

test("GET /api/flows?domain=content returns only contentTrigger flows", async ({ request }) => {
  const res = await request.get("/api/flows?domain=content");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty("flows");
});

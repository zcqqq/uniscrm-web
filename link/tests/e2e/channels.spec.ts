import { test, expect } from "@playwright/test";

test("channels page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).not.toHaveTitle(/error/i);
  const response = page.url();
  expect(response).not.toContain("500");
});

test("X OAuth redirect works with valid client_id", async ({ request }) => {
  const res = await request.get("/api/auth/x/connect", { maxRedirects: 0 });
  expect([302, 307]).toContain(res.status());
  const location = res.headers()["location"] || "";
  expect(location).toContain("x.com");
});

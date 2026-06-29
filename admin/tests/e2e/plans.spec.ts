import { test, expect } from "@playwright/test";

test("admin health check responds", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data.status).toBe("ok");
});

import { test, expect } from "@playwright/test";

test("GET /internal/plans returns tier list", async ({ request }) => {
  const res = await request.get("/internal/plans");
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data.plans).toBeDefined();
  expect(data.plans.length).toBeGreaterThan(0);
});

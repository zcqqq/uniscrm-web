import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("vitest-pool-workers bootstrap", () => {
  it("has the FLOW_DB binding available", () => {
    expect(env.FLOW_DB).toBeDefined();
  });
});

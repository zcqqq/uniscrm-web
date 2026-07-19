/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

describe("GET /public/media/:key", () => {
  it("returns the stored object with its content-type", async () => {
    const bucket = env.MEDIA_BUCKET;
    await bucket.put("test-key-1", "hello world", { httpMetadata: { contentType: "text/plain" } });

    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/public/media/test-key-1"),
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(await res.text()).toBe("hello world");
  });

  it("returns 404 for a key that doesn't exist", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/public/media/does-not-exist"),
      env
    );
    expect(res.status).toBe(404);
  });
});

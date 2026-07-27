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
    expect(await res.text()).toContain("48 hours");
  });

  // A browser opening an expired link (an analytics node log, a published post) sends
  // Accept: text/html, which used to hit the SPA fallback in fetch() and silently render the
  // app's default page instead of telling the visitor the video had expired.
  it("tells a browser the video expired instead of falling back to the SPA", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/public/media/also-gone", {
        headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      }),
      env
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Video expired");
    expect(body).toContain("48 hours");
    expect(body).not.toContain("<div id=\"root\"");
  });
});

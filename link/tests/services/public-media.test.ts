import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

function mockR2Bucket(objects: Record<string, { body: string; contentType: string }>) {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      const obj = objects[key];
      if (!obj) return null;
      return { body: new Response(obj.body).body, httpMetadata: { contentType: obj.contentType } };
    }),
  };
}

describe("GET /public/media/:key", () => {
  it("streams an existing object with its stored content-type", async () => {
    const bucket = mockR2Bucket({ "test-key-1": { body: "fake image bytes", contentType: "image/jpeg" } });

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/public/media/test-key-1"),
      { ...env, MEDIA_BUCKET: bucket } as any
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(await res.text()).toBe("fake image bytes");
  });

  it("returns 404 for a missing key", async () => {
    const bucket = mockR2Bucket({});

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/public/media/does-not-exist"),
      { ...env, MEDIA_BUCKET: bucket } as any
    );

    expect(res.status).toBe(404);
  });
});

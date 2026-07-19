import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const tenantDataDbRunMock = vi.fn().mockResolvedValue({ changes: 1 });

// Same reasoning/pattern as routes-internal-content.test.ts: the real TenantDataDB talks to
// the Cloudflare D1 REST API over global fetch, which would collide with this file's
// vi.stubGlobal("fetch", ...) mocks for content-generate/content-generate-image/TikTok calls.
vi.mock("../../../shared/tenant-data-db", () => ({
  TenantDataDB: class {
    query() {
      return Promise.resolve([]);
    }
    run(...args: unknown[]) {
      return tenantDataDbRunMock(...args);
    }
  },
}));

function mockLinkDb(channelRow: { config: string; channel_type: string; tenant_id: number } | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(channelRow),
      }),
    }),
  };
}

function mockWebDb(d1DatabaseId: string | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(d1DatabaseId ? { d1_database_id: d1DatabaseId } : null),
      }),
    }),
  };
}


const baseBody = {
  contentId: "content-1",
  channelId: "tiktok-chan-1",
  prompts: { title: "Write a catchy title", description: "Write a caption", message_image: "a cyberpunk lizard" },
  textProvider: "none" as const,
  imageCount: 2,
  imageProvider: "default" as const,
  flowId: "flow-1",
};

const channelRow = { config: JSON.stringify({ access_token: "tok-1" }), channel_type: "TIKTOK", tenant_id: 1 };

describe("POST /internal/tiktok/photo-post", () => {
  const testEnv = { ...env, INTERNAL_SECRET: "test-internal-secret" };

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("generates images, forwards content's URLs, and publishes on success (best-effort: 1 of 2 images failing still succeeds)", async () => {
    tenantDataDbRunMock.mockClear();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/internal/generate-image")) {
        // First call succeeds, second call fails -- best-effort should still publish with 1 image.
        const priorCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("generate-image")).length;
        if (priorCalls === 1) {
          return new Response(JSON.stringify({ url: "https://content-dev.uni-scrm.com/public/media/fake-key-1" }), { status: 200 });
        }
        return new Response("upstream error", { status: 502 });
      }
      if (url.includes("/v2/post/publish/content/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub-1" }, error: { code: "ok", message: "" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") } as any
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    const publishCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/v2/post/publish/content/init/"));
    const publishBody = JSON.parse(publishCall![1].body);
    expect(publishBody.source_info.photo_images).toEqual(["https://content-dev.uni-scrm.com/public/media/fake-key-1"]);
    expect(publishBody.post_info.title).toBe("Write a catchy title"); // textProvider: "none" -> literal prompt text
    expect(tenantDataDbRunMock).toHaveBeenCalledTimes(1); // recordPublishedContent wrote the new content row
    vi.unstubAllGlobals();
  });

  it("fails without calling TikTok when all image generations fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream error", { status: 502 })));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify(baseBody),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1") } as any
    );

    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(false);
    vi.unstubAllGlobals();
  });
});

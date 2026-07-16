# TikTok Photo-Post Content Action with AI Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `tiktokContentAction` flow node that generates a title, description, and 1-9 images (via Cloudflare Workers AI or OpenAI, BYOK) and publishes them as a TikTok photo-post draft (`MEDIA_UPLOAD` mode) to the user's TikTok inbox.

**Architecture:** `content` gains an image-generation provider layer (`ImageProvider`, mirroring the existing `LlmProvider`) and a new `/internal/generate-image` route. `link` gains a new R2 bucket for transient public image hosting, a `GET /public/media/:key` public route, a TikTok Content Posting API client, and a new `/internal/tiktok/photo-post` orchestration route that calls `content` for text+images, stores images in R2, and calls TikTok. `flow` gains a new `tiktokContentAction` node type wired through `engine.ts`/`index.ts`/`Inspector.tsx`, parallel to (not replacing) the existing `xContentAction`.

**Tech Stack:** Hono (all three Workers), Cloudflare Workers AI (`@cf/black-forest-labs/flux-1-schnell`), OpenAI Images API (`gpt-image-1`), Cloudflare R2, TikTok Content Posting API v2, React/Zustand (`flow`'s frontend), `@cloudflare/vitest-pool-workers`.

## Global Constraints

- `content` never talks to TikTok directly — all external-channel interaction lives in `link` (existing module boundary, restated in the design spec).
- Image bytes are never persisted in `content`'s D1 — pass straight through, no new table (repo-wide rule against storing external payloads in the DB).
- Image generation is **best-effort per requested image**: a failed individual image generation is dropped, not retried; the post proceeds with whatever succeeded. Zero successes is a hard failure (no TikTok call made).
- Title/description generation is **all-or-nothing**: if either fails (provider ≠ `"none"`), the whole action fails.
- Post mode is **`MEDIA_UPLOAD`** (draft-to-inbox), not `DIRECT_POST` — the TikTok app is not yet audited. No `privacy_level` field needed for this mode.
- Source method is **`PULL_FROM_URL`** — TikTok's photo-post API has no `FILE_UPLOAD` option (that's video-only). Every image needs a publicly reachable URL.
- Success/failed branching is decided purely by the `init` call's HTTP response (`2xx` + `error.code === "ok"` → success) — no status polling, matching `flow/CLAUDE.md`'s existing third-party-action convention.
- Fixed model constants for MVP, no per-tenant settings-page configuration: Workers AI default = `@cf/black-forest-labs/flux-1-schnell` (4 steps, its documented default), OpenAI BYOK = `gpt-image-1` (never send `response_format` to this model — it always returns `b64_json` and 400s on that param, unlike dall-e-2/3).
- Skill content (if selected) is folded into prompts uncapped, no truncation — a too-long skill for an image provider simply surfaces as a generation failure, handled like any other.
- No proactive "needs reconnect" detection for TikTok channels missing the new `video.upload` scope — a photo-post attempt against one just fails at TikTok's API and takes the normal failed-branch path.
- `xContentAction` (X-only) is not touched by this plan — `tiktokContentAction` is a new, standalone action type.

---

### Task 1: Image provider interface + base64 helper + Workers AI image provider

**Files:**
- Create: `content/src/providers/image-interface.ts`
- Create: `content/src/providers/workers-ai-image.ts`
- Test: `content/tests/providers/workers-ai-image.test.ts`

**Interfaces:**
- Produces: `ImageProvider` interface (`generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }>`), `base64ToBytes(base64: string): ArrayBuffer` helper, `WorkersAiImageProvider` class implementing `ImageProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// content/tests/providers/workers-ai-image.test.ts
import { describe, it, expect, vi } from "vitest";
import { WorkersAiImageProvider } from "../../src/providers/workers-ai-image";

describe("WorkersAiImageProvider", () => {
  it("calls env.AI.run with the given model/prompt at 4 steps, decoding the base64 JPEG response into bytes", async () => {
    const base64Jpeg = btoa("fake-jpeg-bytes");
    const aiRun = vi.fn().mockResolvedValue({ image: base64Jpeg });
    const provider = new WorkersAiImageProvider({ run: aiRun } as any);

    const result = await provider.generate("a cyberpunk lizard", "@cf/black-forest-labs/flux-1-schnell");

    expect(aiRun).toHaveBeenCalledWith("@cf/black-forest-labs/flux-1-schnell", { prompt: "a cyberpunk lizard", steps: 4 });
    expect(result.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(result.bytes)).toBe("fake-jpeg-bytes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/providers/workers-ai-image.test.ts`
Expected: FAIL with "Cannot find module '../../src/providers/workers-ai-image'"

- [ ] **Step 3: Write the interface, base64 helper, and provider**

```ts
// content/src/providers/image-interface.ts
export interface ImageProvider {
  generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }>;
}

export function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
```

```ts
// content/src/providers/workers-ai-image.ts
import type { ImageProvider } from "./image-interface";
import { base64ToBytes } from "./image-interface";

export class WorkersAiImageProvider implements ImageProvider {
  constructor(private ai: Ai) {}

  async generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    // flux-1-schnell's response shape is { image: string } (base64-encoded JPEG),
    // unlike the text models' { response: string } shape.
    const result = (await this.ai.run(model, { prompt, steps: 4 })) as { image: string };
    return { bytes: base64ToBytes(result.image), contentType: "image/jpeg" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/providers/workers-ai-image.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add content/src/providers/image-interface.ts content/src/providers/workers-ai-image.ts content/tests/providers/workers-ai-image.test.ts
git commit -m "feat(content): add ImageProvider interface and Workers AI image provider"
```

---

### Task 2: OpenAI image provider

**Files:**
- Create: `content/src/providers/openai-image.ts`
- Test: `content/tests/providers/openai-image.test.ts`

**Interfaces:**
- Consumes: `ImageProvider` interface, `base64ToBytes` from Task 1 (`content/src/providers/image-interface.ts`).
- Produces: `OpenAiImageProvider` class implementing `ImageProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// content/tests/providers/openai-image.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiImageProvider } from "../../src/providers/openai-image";

describe("OpenAiImageProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls the images/generations endpoint with the given key/prompt/model, never sending response_format", async () => {
    const base64Png = btoa("fake-png-bytes");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: base64Png }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiImageProvider("sk-test");
    const result = await provider.generate("a cyberpunk lizard", "gpt-image-1");

    expect(result.contentType).toBe("image/png");
    expect(new TextDecoder().decode(result.bytes)).toBe("fake-png-bytes");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ model: "gpt-image-1", prompt: "a cyberpunk lizard", size: "1024x1024" });
    expect(body.response_format).toBeUndefined();
  });

  it("throws with the response body on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad key", { status: 401 })));
    const provider = new OpenAiImageProvider("sk-bad");
    await expect(provider.generate("a lizard", "gpt-image-1")).rejects.toThrow("OpenAI image generate failed: 401");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/providers/openai-image.test.ts`
Expected: FAIL with "Cannot find module '../../src/providers/openai-image'"

- [ ] **Step 3: Write the provider**

```ts
// content/src/providers/openai-image.ts
import type { ImageProvider } from "./image-interface";
import { base64ToBytes } from "./image-interface";

export class OpenAiImageProvider implements ImageProvider {
  constructor(private apiKey: string) {}

  async generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    // gpt-image-1 does not accept response_format (400s "Unknown parameter") -- unlike
    // dall-e-2/3, it always returns b64_json unconditionally.
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model, prompt, size: "1024x1024" }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI image generate failed: ${res.status} ${await res.text()}`);
    }

    const body = (await res.json()) as { data: { b64_json: string }[] };
    return { bytes: base64ToBytes(body.data[0].b64_json), contentType: "image/png" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/providers/openai-image.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add content/src/providers/openai-image.ts content/tests/providers/openai-image.test.ts
git commit -m "feat(content): add OpenAI image provider (gpt-image-1)"
```

---

### Task 3: `generateImage` service

**Files:**
- Create: `content/src/services/generate-image.ts`
- Test: `content/tests/generate-image.test.ts`

**Interfaces:**
- Consumes: `WorkersAiImageProvider` (Task 1), `OpenAiImageProvider` (Task 2), `getSkillContent` from `content/src/services/skill-content.ts` (existing, returns `Promise<string | null>`), `getTenantLlmCredentials` from `content/src/services/llm-credentials.ts` (existing, `(env, tenantId, "openai") => Promise<{apiKey, model} | null>`), `Env` from `content/src/types.ts`.
- Produces: `GenerateImageParams` type, `generateImage(env, params): Promise<{ bytes: ArrayBuffer; contentType: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// content/tests/generate-image.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { generateImage } from "../src/services/generate-image";
import * as credentialsModule from "../src/services/llm-credentials";
import * as skillContentModule from "../src/services/skill-content";

describe("generateImage", () => {
  afterEach(() => vi.restoreAllMocks());

  const baseParams = { tenantId: 1, prompt: "a cyberpunk lizard", provider: "default" as const };

  it("uses Workers AI's flux-1-schnell for provider: 'default'", async () => {
    const base64Jpeg = btoa("jpeg-bytes");
    const aiRun = vi.fn().mockResolvedValue({ image: base64Jpeg });

    const result = await generateImage({ AI: { run: aiRun } } as any, baseParams);

    expect(aiRun).toHaveBeenCalledWith("@cf/black-forest-labs/flux-1-schnell", { prompt: "a cyberpunk lizard", steps: 4 });
    expect(result.contentType).toBe("image/jpeg");
  });

  it("uses the tenant's OpenAI BYOK credentials for provider: 'openai', with the fixed gpt-image-1 model (not the tenant's configured text model)", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue({ apiKey: "sk-test", model: "gpt-4o-mini" });
    const base64Png = btoa("png-bytes");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: base64Png }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateImage({} as any, { ...baseParams, provider: "openai" });

    expect(result.contentType).toBe("image/png");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-image-1");
    vi.unstubAllGlobals();
  });

  it("throws clearly when provider: 'openai' has no configured credentials", async () => {
    vi.spyOn(credentialsModule, "getTenantLlmCredentials").mockResolvedValue(null);
    await expect(generateImage({} as any, { ...baseParams, provider: "openai" })).rejects.toThrow(/No openai credentials configured/);
  });

  it("folds cached skill content into the prompt, uncapped, when skillId is set", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("Use warm, saturated colors.");
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("jpeg-bytes") });

    await generateImage({ AI: { run: aiRun } } as any, { ...baseParams, skillId: "marketingskills-social" });

    expect(skillContentModule.getSkillContent).toHaveBeenCalledWith(expect.anything(), "marketingskills-social");
    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: "a cyberpunk lizard\n\nUse warm, saturated colors." })
    );
  });

  it("omits skill folding when skillId is 'none' or absent", async () => {
    const getSkillContentSpy = vi.spyOn(skillContentModule, "getSkillContent");
    const aiRun = vi.fn().mockResolvedValue({ image: btoa("jpeg-bytes") });

    await generateImage({ AI: { run: aiRun } } as any, { ...baseParams, skillId: "none" });

    expect(getSkillContentSpy).not.toHaveBeenCalled();
    expect(aiRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ prompt: "a cyberpunk lizard" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/generate-image.test.ts`
Expected: FAIL with "Cannot find module '../src/services/generate-image'"

- [ ] **Step 3: Write the service**

```ts
// content/src/services/generate-image.ts
import type { Env } from "../types";
import * as credentialsModule from "./llm-credentials";
import { getSkillContent } from "./skill-content";
import { WorkersAiImageProvider } from "../providers/workers-ai-image";
import { OpenAiImageProvider } from "../providers/openai-image";
import type { ImageProvider } from "../providers/image-interface";

const WORKERS_AI_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const OPENAI_IMAGE_MODEL = "gpt-image-1";

export interface GenerateImageParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai";
  skillId?: string;
}

export async function generateImage(
  env: Env,
  params: GenerateImageParams
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const skillContent = params.skillId && params.skillId !== "none"
    ? await getSkillContent(env, params.skillId)
    : null;
  const prompt = skillContent ? `${params.prompt}\n\n${skillContent}` : params.prompt;

  if (params.provider === "default") {
    return new WorkersAiImageProvider(env.AI).generate(prompt, WORKERS_AI_IMAGE_MODEL);
  }

  const credentials = await credentialsModule.getTenantLlmCredentials(env, params.tenantId, "openai");
  if (!credentials) {
    throw new Error(`No openai credentials configured for this tenant`);
  }

  const provider: ImageProvider = new OpenAiImageProvider(credentials.apiKey);
  return provider.generate(prompt, OPENAI_IMAGE_MODEL);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/generate-image.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add content/src/services/generate-image.ts content/tests/generate-image.test.ts
git commit -m "feat(content): add generateImage service (provider dispatch + skill folding)"
```

---

### Task 4: `POST /internal/generate-image` route

**Files:**
- Modify: `content/src/routes-internal.ts`
- Test: `content/tests/routes-internal.test.ts`

**Interfaces:**
- Consumes: `generateImage` from Task 3.
- Produces: `POST /internal/generate-image` — `{tenantId, prompt, provider, skillId?}` → `200` with raw image bytes + `Content-Type` header, or `502` on failure.

- [ ] **Step 1: Write the failing test**

Add to `content/tests/routes-internal.test.ts` (new `describe` block, after the existing `describe("POST /internal/skills/:id/refresh", ...)` block):

```ts
describe("POST /internal/generate-image", () => {
  const testEnv = {
    ...env,
    INTERNAL_SECRET: "test-internal-secret",
    AI: { run: async () => ({ image: btoa("fake-jpeg-bytes") }) } as unknown as Ai,
  };

  it("rejects requests missing the internal secret", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 1, prompt: "a lizard", provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it("returns image bytes with the right content-type on success (default provider, Workers AI)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "a lizard", provider: "default" }),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe("fake-jpeg-bytes");
  });

  it("returns 502 when provider: 'openai' has no configured credentials", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "a lizard", provider: "openai" }),
      }),
      testEnv
    );
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/routes-internal.test.ts`
Expected: FAIL — no `/internal/generate-image` route registered (404s where 200/502/403 expected)

- [ ] **Step 3: Add the route**

In `content/src/routes-internal.ts`, add the import and new route (after the existing `/generate` route, before `/skills/:id/refresh`):

```ts
import { generateImage } from "./services/generate-image";
```

```ts
router.post("/generate-image", async (c) => {
  const { tenantId, prompt, provider, skillId } = await c.req.json<{
    tenantId: number;
    prompt: string;
    provider: "default" | "openai";
    skillId?: string;
  }>();

  if (!tenantId || !prompt || !provider) {
    return c.json({ error: "tenantId, prompt, provider required" }, 400);
  }

  try {
    const { bytes, contentType } = await generateImage(c.env, { tenantId, prompt, provider, skillId });
    return new Response(bytes, { status: 200, headers: { "Content-Type": contentType } });
  } catch (err) {
    console.error(JSON.stringify({ event: "generate_image_failed", tenantId, provider, error: String(err) }));
    return c.json({ error: "Image generation failed" }, 502);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/routes-internal.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add content/src/routes-internal.ts content/tests/routes-internal.test.ts
git commit -m "feat(content): add POST /internal/generate-image route"
```

---

### Task 5: `link` R2 bucket binding + public media route

**Files:**
- Modify: `link/wrangler.toml`
- Modify: `link/src/types.ts`
- Modify: `link/src/index.ts`
- Test: `link/tests/services/public-media.test.ts`

**Interfaces:**
- Produces: `Env.MEDIA_BUCKET: R2Bucket`, `GET /public/media/:key` (200 streaming the object with its stored content-type, 404 if missing).

**Important — this module's test-binding quirk:** every existing test in `link/tests/services/routes-internal-content.test.ts` hand-mocks `LINK_DB`/`WEB_DB` rather than using real bindings from `cloudflare:test`'s `env` — a comment in that file (search for "Empirically, this repo's link/vitest.config.ts") documents that real bindings don't wire up for this module's test runner. Follow that same established pattern here: override `MEDIA_BUCKET` with a hand-mocked object per test, do not rely on a real R2 binding from `env`.

- [ ] **Step 1: Write the failing test**

```ts
// link/tests/services/public-media.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/public-media.test.ts`
Expected: FAIL — no `/public/media/:key` route registered yet (404 from routing, not the mocked-404 assertion; the 200 test also fails since the route doesn't exist)

- [ ] **Step 3: Add the R2 binding and route**

In `link/wrangler.toml`, add after `[[env.dev.d1_databases]]`'s block (inside `[env.dev]`):

```toml
[[env.dev.r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "uniscrm-link-media-dev"
```

And in the `[env.production]` section, after its `[[env.production.d1_databases]]` block:

```toml
[[env.production.r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "uniscrm-link-media"
```

In `link/src/types.ts`, add to the `Env` interface (after `ASSETS: Fetcher;`):

```ts
  MEDIA_BUCKET: R2Bucket;
```

In `link/src/index.ts`, add after the `app.get("/health", ...)` line:

```ts
app.get("/public/media/:key", async (c) => {
  const object = await c.env.MEDIA_BUCKET.get(c.req.param("key"));
  if (!object) return c.notFound();
  return new Response(object.body, {
    status: 200,
    headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream" },
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/public-media.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add link/wrangler.toml link/src/types.ts link/src/index.ts link/tests/services/public-media.test.ts
git commit -m "feat(link): add MEDIA_BUCKET R2 binding and public media serving route"
```

**Manual follow-up (not part of automated tests, do once per environment before end-to-end use):**
```bash
wrangler r2 bucket create uniscrm-link-media-dev
wrangler r2 bucket lifecycle add uniscrm-link-media-dev --id expire-after-48h --expire-days 2
wrangler r2 bucket create uniscrm-link-media
wrangler r2 bucket lifecycle add uniscrm-link-media --id expire-after-48h --expire-days 2
```

---

### Task 6: TikTok photo-post publish service

**Files:**
- Create: `link/src/services/tiktok-publish.ts`
- Test: `link/tests/services/tiktok-publish.test.ts`

**Interfaces:**
- Produces: `initPhotoPost(accessToken: string, photoUrls: string[], title: string, description: string): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean }>`.

- [ ] **Step 1: Write the failing test**

```ts
// link/tests/services/tiktok-publish.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { initPhotoPost } from "../../src/services/tiktok-publish";

describe("initPhotoPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls TikTok's photo-post init endpoint with MEDIA_UPLOAD/PULL_FROM_URL and returns ok + publishId on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { publish_id: "pub-123" }, error: { code: "ok", message: "" } }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await initPhotoPost("access-token-1", ["https://link-dev.uni-scrm.com/public/media/a", "https://link-dev.uni-scrm.com/public/media/b"], "My Title", "My description");

    expect(result).toEqual({ ok: true, publishId: "pub-123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://open.tiktokapis.com/v2/post/publish/content/init/");
    expect(init.headers.Authorization).toBe("Bearer access-token-1");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      media_type: "PHOTO",
      post_mode: "MEDIA_UPLOAD",
      post_info: { title: "My Title", description: "My description" },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: ["https://link-dev.uni-scrm.com/public/media/a", "https://link-dev.uni-scrm.com/public/media/b"],
        photo_cover_index: 0,
      },
    });
  });

  it("returns rateLimited: true when TikTok reports rate_limit_exceeded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "too many requests" } }), { status: 429 })
    ));

    const result = await initPhotoPost("access-token-1", ["https://link-dev.uni-scrm.com/public/media/a"], "T", "D");

    expect(result).toEqual({ ok: false, rateLimited: true });
  });

  it("returns ok: false for any other error code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "invalid_params", message: "bad request" } }), { status: 400 })
    ));

    const result = await initPhotoPost("access-token-1", ["https://link-dev.uni-scrm.com/public/media/a"], "T", "D");

    expect(result).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/tiktok-publish.test.ts`
Expected: FAIL with "Cannot find module '../../src/services/tiktok-publish'"

- [ ] **Step 3: Write the service**

```ts
// link/src/services/tiktok-publish.ts
export async function initPhotoPost(
  accessToken: string,
  photoUrls: string[],
  title: string,
  description: string
): Promise<{ ok: boolean; publishId?: string; rateLimited?: boolean }> {
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      media_type: "PHOTO",
      post_mode: "MEDIA_UPLOAD",
      post_info: { title, description },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: photoUrls,
        photo_cover_index: 0,
      },
    }),
  });

  const rawText = await res.text();
  let body: { data?: { publish_id?: string }; error?: { code: string; message: string } } | undefined;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = undefined;
  }

  const errorCode = body?.error?.code;
  if (errorCode === "rate_limit_exceeded") {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok || (errorCode && errorCode !== "ok")) {
    return { ok: false };
  }

  return { ok: true, publishId: body?.data?.publish_id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/tiktok-publish.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add link/src/services/tiktok-publish.ts link/tests/services/tiktok-publish.test.ts
git commit -m "feat(link): add TikTok photo-post publish service (initPhotoPost)"
```

---

### Task 7: `recordPublishedContent` gains an explicit `contentType` parameter

**Files:**
- Modify: `link/src/services/content.ts`
- Modify: `link/tests/services/content.test.ts` (existing file — extend its existing `describe("recordPublishedContent", ...)` block, which already has `tenantDb`/`ai`/`vectorize` set up in a `beforeEach` via that file's `createMockTenantDb()`/`createMockAi()`/`createMockVectorize()` helpers, and constructs `new ContentService(tenantDb as any, vectorize as any, ai as any, 42)` per test)

**Interfaces:**
- Consumes: none new.
- Produces: `recordPublishedContent(channelId, channelType, sourceContentId, contentText, ref, contentType = "TWEET")` — backward-compatible, existing X call sites unaffected.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("recordPublishedContent", ...)` block in `link/tests/services/content.test.ts`, right after its existing `it("inserts a published content row referencing the source content and flow", ...)` test — reusing that same test's `tenantDb`/`ai`/`vectorize` from the block's `beforeEach`:

```ts
  it("stores an explicit contentType when given (e.g. TikTok's PHOTO_POST), instead of the hardcoded TWEET default", async () => {
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);

    await svc.recordPublishedContent(
      "channel-1", "TIKTOK", "publish-id-1", "a caption",
      { generatedFromContentId: "content-1", flowId: "flow-1" },
      "PHOTO_POST"
    );

    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["channel-1", "TIKTOK", "PHOTO_POST", "publish-id-1", "a caption", "published"])
    );
  });

  it("still defaults to TWEET when contentType is omitted (existing X call sites unaffected)", async () => {
    const svc = new ContentService(tenantDb as any, vectorize as any, ai as any, 42);

    await svc.recordPublishedContent("channel-2", "X", "tweet-id-1", "a tweet", {
      generatedFromContentId: "content-2",
      flowId: "flow-1",
    });

    expect(tenantDb.run).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO content"),
      expect.arrayContaining(["channel-2", "X", "TWEET", "tweet-id-1", "a tweet", "published"])
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/content.test.ts`
Expected: FAIL — the current `INSERT` statement hardcodes `'TWEET'` as a SQL literal rather than binding it as a parameter, so `content_type` never appears as a bound value in `tenantDb.run`'s params array (the `expect.arrayContaining([...])` assertions fail to find `"PHOTO_POST"`/`"TWEET"` among the bound params)

- [ ] **Step 3: Update the method**

In `link/src/services/content.ts`, replace:

```ts
  async recordPublishedContent(
    channelId: string,
    channelType: ChannelType,
    sourceContentId: string,
    contentText: string,
    ref: { generatedFromContentId: string; flowId: string }
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.tenantDb.run(
      `INSERT INTO content (id, channel_id, channel_type, content_type, source_content_id, content_text, status, raw_data, created_at, updated_at)
       VALUES (?, ?, ?, 'TWEET', ?, ?, ?, ?, ?, ?)`,
      [id, channelId, channelType, sourceContentId, contentText, "published", JSON.stringify(ref), now, now]
    );
  }
```

with:

```ts
  async recordPublishedContent(
    channelId: string,
    channelType: ChannelType,
    sourceContentId: string,
    contentText: string,
    ref: { generatedFromContentId: string; flowId: string },
    contentType: string = "TWEET"
  ): Promise<void> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.tenantDb.run(
      `INSERT INTO content (id, channel_id, channel_type, content_type, source_content_id, content_text, status, raw_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, channelId, channelType, contentType, sourceContentId, contentText, "published", JSON.stringify(ref), now, now]
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/content.test.ts` (same file as Step 2)
Expected: PASS (both new tests, plus all pre-existing tests in the file still green)

- [ ] **Step 5: Commit**

```bash
git add link/src/services/content.ts link/tests/services/content.test.ts
git commit -m "feat(link): recordPublishedContent accepts an explicit contentType (default TWEET, unchanged for X)"
```

---

### Task 8: `POST /internal/tiktok/photo-post` orchestration route

**Files:**
- Modify: `link/src/routes-internal.ts`
- Test: `link/tests/services/routes-internal-tiktok-photo-post.test.ts`

**Interfaces:**
- Consumes: `content`'s `/internal/generate` (existing, `{tenantId, prompt, provider, skillId} → {text}`) and `/internal/generate-image` (Task 4, `{tenantId, prompt, provider, skillId} → raw bytes + Content-Type`), `TikTokTokenService.getValidToken` (existing, `link/src/services/tiktok-token.ts`), `initPhotoPost` (Task 6), `recordPublishedContent` with `contentType` (Task 7), `Env.MEDIA_BUCKET` (Task 5).
- Produces: `POST /internal/tiktok/photo-post` — request body `{contentId, channelId, titlePrompt, descriptionPrompt, textProvider, textSkillId?, imagePrompt, imageCount, imageProvider, imageSkillId?, flowId?}`, response `{ok: boolean, rateLimited?: boolean, rateLimitReset?: string}`.

**Important — reuse this module's established test-mocking pattern** (see `link/tests/services/routes-internal-content.test.ts`, which tests the sibling `/internal/content/create-post` route this route is modeled on): `LINK_DB`/`WEB_DB` are always hand-mocked per test (real bindings don't wire up for this module's test runner — see that file's comment starting "Empirically, this repo's link/vitest.config.ts"), and `TenantDataDB` is replaced with a `vi.mock` so `recordPublishedContent` never makes a real Cloudflare D1 REST API call.

- [ ] **Step 1: Write the failing test**

```ts
// link/tests/services/routes-internal-tiktok-photo-post.test.ts
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

function mockMediaBucket() {
  return { put: vi.fn().mockResolvedValue(undefined) };
}

const baseBody = {
  contentId: "content-1",
  channelId: "tiktok-chan-1",
  titlePrompt: "Write a catchy title",
  descriptionPrompt: "Write a caption",
  textProvider: "none" as const,
  imagePrompt: "a cyberpunk lizard",
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

  it("generates images, stores them in R2, and publishes on success (best-effort: 1 of 2 images failing still succeeds)", async () => {
    tenantDataDbRunMock.mockClear();
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/internal/generate-image")) {
        // First call succeeds, second call fails -- best-effort should still publish with 1 image.
        const priorCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("generate-image")).length;
        if (priorCalls === 1) {
          return new Response("fake-jpeg-bytes", { status: 200, headers: { "Content-Type": "image/jpeg" } });
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
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1"), MEDIA_BUCKET: mockMediaBucket() } as any
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);

    const publishCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/v2/post/publish/content/init/"));
    const publishBody = JSON.parse(publishCall![1].body);
    expect(publishBody.source_info.photo_images).toHaveLength(1); // only the 1 successful image
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
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), WEB_DB: mockWebDb("tenant-db-1"), MEDIA_BUCKET: mockMediaBucket() } as any
    );

    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(false);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-photo-post.test.ts`
Expected: FAIL — route doesn't exist yet (404s)

- [ ] **Step 3: Add the route**

In `link/src/routes-internal.ts`, add the imports (near the top, alongside the existing service imports):

```ts
import { TikTokTokenService } from "./services/tiktok-token";
import { initPhotoPost } from "./services/tiktok-publish";
```

Add the route (after the existing `/content/create-post` route):

```ts
  router.post("/tiktok/photo-post", async (c) => {
    const {
      contentId, channelId, titlePrompt, descriptionPrompt, textProvider, textSkillId,
      imagePrompt, imageCount, imageProvider, imageSkillId, flowId,
    } = await c.req.json<{
      contentId: string; channelId: string;
      titlePrompt: string; descriptionPrompt: string;
      textProvider: "default" | "openai" | "anthropic" | "none"; textSkillId?: string;
      imagePrompt: string; imageCount: number;
      imageProvider: "default" | "openai"; imageSkillId?: string;
      flowId?: string | null;
    }>();

    const channel = await c.env.LINK_DB.prepare("SELECT config, channel_type, tenant_id FROM channels WHERE id = ?")
      .bind(channelId).first<{ config: string; channel_type: string; tenant_id: number }>();
    if (!channel || channel.channel_type !== "TIKTOK") return c.json({ ok: false }, 200);

    const tenantId = channel.tenant_id;

    const generateText = async (prompt: string): Promise<string | null> => {
      if (textProvider === "none") return prompt;
      const res = await fetch(`${c.env.CONTENT_URL}/internal/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId, prompt, provider: textProvider, skillId: textSkillId }),
      });
      if (!res.ok) return null;
      const body = await res.json<{ text: string }>();
      return body.text;
    };

    const [title, description] = await Promise.all([generateText(titlePrompt), generateText(descriptionPrompt)]);
    if (title === null || description === null) {
      console.error(JSON.stringify({ event: "tiktok_photo_post_text_failed", contentId, channelId }));
      return c.json({ ok: false }, 200);
    }

    const requestedCount = Math.max(1, Math.min(9, imageCount || 1));
    const photoUrls: string[] = [];
    for (let i = 0; i < requestedCount; i++) {
      const res = await fetch(`${c.env.CONTENT_URL}/internal/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId, prompt: imagePrompt, provider: imageProvider, skillId: imageSkillId }),
      });
      if (!res.ok) continue;
      const bytes = await res.arrayBuffer();
      const contentType = res.headers.get("Content-Type") || "image/jpeg";
      const key = crypto.randomUUID();
      await c.env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
      photoUrls.push(`${c.env.LINK_URL}/public/media/${key}`);
    }

    console.log(JSON.stringify({
      event: "tiktok_photo_post_images", contentId, channelId,
      imagesRequested: requestedCount, imagesSucceeded: photoUrls.length,
    }));

    if (photoUrls.length === 0) {
      return c.json({ ok: false }, 200);
    }

    const tokenService = new TikTokTokenService(c.env.LINK_DB, c.env.TIKTOK_CLIENT_KEY, c.env.TIKTOK_CLIENT_SECRET);
    const accessToken = await tokenService.getValidToken(channelId);
    const publishResult = await initPhotoPost(accessToken, photoUrls, title, description);

    console.log(JSON.stringify({
      event: "tiktok_photo_post", contentId, channelId,
      ok: publishResult.ok, rateLimited: !!publishResult.rateLimited,
    }));

    if (publishResult.rateLimited) {
      return c.json({ ok: false, rateLimited: true, rateLimitReset: new Date(Date.now() + 15 * 60 * 1000).toISOString() });
    }
    if (!publishResult.ok) {
      return c.json({ ok: false }, 200);
    }

    const tenantRow = await c.env.WEB_DB.prepare("SELECT d1_database_id FROM tenants WHERE tenant_id = ?")
      .bind(tenantId).first<{ d1_database_id: string | null }>();
    if (tenantRow?.d1_database_id) {
      const tenantDataDb = new TenantDataDB(c.env.CF_ACCOUNT_ID, c.env.CF_D1_API_TOKEN, tenantRow.d1_database_id);
      const contentService = new ContentService(tenantDataDb, c.env.VECTORIZE, c.env.AI, tenantId);
      await contentService.recordPublishedContent(
        channelId, "TIKTOK", publishResult.publishId || crypto.randomUUID(), description,
        { generatedFromContentId: contentId, flowId: flowId || "" }, "PHOTO_POST"
      );
    }

    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-photo-post.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-tiktok-photo-post.test.ts
git commit -m "feat(link): add POST /internal/tiktok/photo-post orchestration route"
```

---

### Task 9: OAuth scope update for TikTok connect

**Files:**
- Modify: `link/src/oauth.ts`
- Test: `link/tests/oauth.test.ts`

**Interfaces:** none new — pure string change.

- [ ] **Step 1: Write the failing test**

This file (`link/tests/oauth.test.ts`) does not import the full worker — it builds a standalone Hono app from `oauthRoutes()` directly and dispatches with `app.request(path, init, env)`, with all bindings hand-mocked (see the existing `buildApp()` helper and the `describe("TikTok OAuth callback", ...)` block for the established pattern). Add a new `describe` block following that same style:

```ts
describe("TikTok OAuth connect", () => {
  it("includes video.upload in the scope (required for photo-post's MEDIA_UPLOAD mode)", async () => {
    const app = buildApp();
    const res = await app.request(
      "/tiktok/connect",
      {},
      { KV: { put: vi.fn().mockResolvedValue(undefined) }, TIKTOK_CLIENT_KEY: "test-client-key" } as any
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("Location") || "";
    // The connect URL is built as a plain (unencoded) template literal -- see the existing
    // line below being changed in Step 3 -- so the comma-separated scope list appears in the
    // Location header literally, not percent-encoded.
    expect(location).toContain("scope=user.info.basic,video.list,video.upload");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/oauth.test.ts`
Expected: FAIL — current scope string is `user.info.basic,video.list` (no `video.upload`)

- [ ] **Step 3: Update the scope string**

In `link/src/oauth.ts`, change:

```ts
    const tiktokUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${c.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.list&response_type=code&redirect_uri=${redirectUri}&state=${state}`;
```

to:

```ts
    const tiktokUrl = `https://www.tiktok.com/v2/auth/authorize/?client_key=${c.env.TIKTOK_CLIENT_KEY}&scope=user.info.basic,video.list,video.upload&response_type=code&redirect_uri=${redirectUri}&state=${state}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/oauth.test.ts`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 5: Commit**

```bash
git add link/src/oauth.ts link/tests/oauth.test.ts
git commit -m "feat(link): add video.upload to TikTok OAuth scope for photo-post"
```

---

### Task 10: `flow` engine — `tiktokContentAction` action collection

**Files:**
- Modify: `flow/src/engine.ts`
- Test: `flow/tests/unit/engine.test.ts`

**Interfaces:**
- Produces: `buildActionData` recognizes `actionType: "tiktokContentAction"`, copying `channelId`, `titlePrompt`, `descriptionPrompt`, `textProvider`, `textSkillId`, `imagePrompt`, `imageCount`, `imageProvider`, `imageSkillId` from node data onto the `ActionResult`, with `hasBranches: true`.

- [ ] **Step 1: Write the failing test**

Add to `flow/tests/unit/engine.test.ts` (in the `describe("collectActions: new content-domain action types", ...)` block, alongside the existing `xContentAction` tests):

```ts
  it("collects a tiktokContentAction action carrying all its fields, defaulting textSkillId/imageSkillId to 'none' and imageCount to 1 when unset", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        {
          id: "a1", type: "action",
          data: {
            actionType: "tiktokContentAction", channelId: "tiktok-chan-1",
            titlePrompt: "Write a title: $content.title", descriptionPrompt: "Write a caption: $content.content_text",
            textProvider: "default", imagePrompt: "A photo of: $content.title", imageProvider: "default",
          },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions).toEqual([
      {
        type: "tiktokContentAction", nodeId: "a1", hasBranches: true, channelId: "tiktok-chan-1",
        titlePrompt: "Write a title: $content.title", descriptionPrompt: "Write a caption: $content.content_text",
        textProvider: "default", textSkillId: "none",
        imagePrompt: "A photo of: $content.title", imageCount: 1, imageProvider: "default", imageSkillId: "none",
      },
    ]);
  });

  it("carries a set imageCount/textSkillId/imageSkillId through for tiktokContentAction", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "chan1", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        {
          id: "a1", type: "action",
          data: {
            actionType: "tiktokContentAction", channelId: "tiktok-chan-1",
            titlePrompt: "t", descriptionPrompt: "d", textProvider: "default", textSkillId: "marketingskills-social",
            imagePrompt: "i", imageCount: 5, imageProvider: "openai", imageSkillId: "marketingskills-social",
          },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    const result = executeFlow(graph, "content.created", { channel_id: "chan1" });
    expect(result.actions[0]).toMatchObject({ imageCount: 5, textSkillId: "marketingskills-social", imageSkillId: "marketingskills-social" });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: FAIL — `tiktokContentAction` isn't recognized by `buildActionData`, so `hasBranches` is `false` and none of the fields are copied

- [ ] **Step 3: Update `buildActionData`**

In `flow/src/engine.ts`, change:

```ts
  const isExternalApi = actionType === "xAction" || actionType === "xContentAction";
```

to:

```ts
  const isExternalApi = actionType === "xAction" || actionType === "xContentAction" || actionType === "tiktokContentAction";
```

And add a new block after the existing `if (actionType === "xContentAction") { ... }` block:

```ts
  if (actionType === "tiktokContentAction") {
    actionData.channelId = targetNode.data.channelId as string;
    actionData.titlePrompt = targetNode.data.titlePrompt as string;
    actionData.descriptionPrompt = targetNode.data.descriptionPrompt as string;
    actionData.textProvider = targetNode.data.textProvider as string;
    actionData.textSkillId = (targetNode.data.textSkillId as string) || "none";
    actionData.imagePrompt = targetNode.data.imagePrompt as string;
    actionData.imageCount = (targetNode.data.imageCount as number) || 1;
    actionData.imageProvider = targetNode.data.imageProvider as string;
    actionData.imageSkillId = (targetNode.data.imageSkillId as string) || "none";
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/engine.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add flow/src/engine.ts flow/tests/unit/engine.test.ts
git commit -m "feat(flow): collect tiktokContentAction fields in buildActionData"
```

---

### Task 11: `flow` — `executeContentActions` dispatches `tiktokContentAction`

**Files:**
- Modify: `flow/src/index.ts`
- Test: `flow/tests/unit/queue-content.test.ts`

**Interfaces:**
- Consumes: `link`'s `/internal/tiktok/photo-post` (Task 8).
- Produces: `executeContentActions` recognizes `action.type === "tiktokContentAction"`, interpolates `$content.xxx` in `titlePrompt`/`descriptionPrompt`/`imagePrompt`, calls `link`, and branches success/failed/rateLimited exactly like the existing `xContentAction` path.

- [ ] **Step 1: Write the failing test**

Add to `flow/tests/unit/queue-content.test.ts` (new `describe` block, after the existing `describe("queue(): xContentAction branch resolution", ...)` block):

```ts
describe("queue(): tiktokContentAction dispatch", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-tiktok1'`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_executions WHERE flow_id = 'flow-tiktok1'`).run();
    vi.unstubAllGlobals();
  });

  it("interpolates $content.xxx fields and calls link's /internal/tiktok/photo-post with all node fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const graphWithTikTok = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        {
          id: "a1", type: "action",
          data: {
            actionType: "tiktokContentAction", channelId: "tiktok-chan-1",
            titlePrompt: "Title: $content.title", descriptionPrompt: "Desc: $content.content_text",
            textProvider: "default", imagePrompt: "Photo of: $content.title",
            imageCount: 3, imageProvider: "default",
          },
          position: { x: 200, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-tiktok1', 1, 'tiktok flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithTikTok).run();

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-tt-1", channelId: "src-chan",
        payload: { title: "Original Title", content_text: "original body text" },
      }),
      env
    );

    const call = fetchMock.mock.calls.find(([u]: [string]) => String(u).includes("/internal/tiktok/photo-post"));
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.titlePrompt).toBe("Title: Original Title");
    expect(body.descriptionPrompt).toBe("Desc: original body text");
    expect(body.imagePrompt).toBe("Photo of: Original Title");
    expect(body.imageCount).toBe(3);
    expect(body.imageProvider).toBe("default");
    expect(body.channelId).toBe("tiktok-chan-1");
  });

  it("schedules a content_flow_pending retry row when link reports rateLimited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, rateLimited: true, rateLimitReset: "2099-01-01T00:00:00.000Z" }), { status: 429 }))
    );

    const graphWithTikTok = JSON.stringify({
      nodes: [
        { id: "t1", type: "xContentTrigger", data: { channelId: "src-chan", mode: "my_posts", conditions: [] }, position: { x: 0, y: 0 } },
        { id: "a1", type: "action", data: { actionType: "tiktokContentAction", channelId: "tiktok-chan-1", titlePrompt: "t", descriptionPrompt: "d", textProvider: "none", imagePrompt: "i", imageProvider: "default" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    });
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-tiktok1', 1, 'tiktok flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphWithTikTok).run();

    await worker.queue(
      makeBatch({ tenantId: "1", eventType: "content.created", contentId: "content-tt-2", channelId: "src-chan", payload: {} }),
      env
    );

    const pending = await env.FLOW_DB.prepare(
      `SELECT retry_action FROM content_flow_pending WHERE flow_id = 'flow-tiktok1' AND content_id = 'content-tt-2'`
    ).first<{ retry_action: string }>();
    expect(JSON.parse(pending?.retry_action || "{}")).toMatchObject({ type: "tiktokContentAction" });

    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = 'flow-tiktok1'`).run();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: FAIL — `tiktokContentAction` isn't dispatched anywhere in `executeContentActions`, so no call to `/internal/tiktok/photo-post` is made

- [ ] **Step 3: Update `executeContentActions`**

In `flow/src/index.ts`, find this exact block inside the `executeContentActions` function (the entire body of the `for (const action of actions) { ... }` loop's `if (action.type === "xContentAction")` clause):

```ts
    if (action.type === "xContentAction") {
      const operation = (action.operation as string) || "create-post";
      let res: Response;
      let logEvent: string;
      let logExtra: Record<string, unknown>;

      if (operation === "repost-post") {
        const tweetId = String(payload?.source_content_id ?? "");
        res = await fetch(`${env.LINK_URL}/internal/x/repost`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ channelId, contentId, tweetId, flowId: flowId || null }),
        });
        logEvent = "content_action_repost";
        logExtra = { channelId, tweetId };
      } else {
        const targetChannelId = action.targetChannelId as string;
        const provider = action.provider as string;
        const skillId = (action.skillId as string) || "none";
        const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
        res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ contentId, interpolatedPrompt, provider, targetChannelId, flowId: flowId || null, skillId }),
        });
        logEvent = "content_action_x_content_action";
        logExtra = { targetChannelId, provider, skillId };
      }

      const body = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: logEvent, contentId, status: res.status, ok: body.ok, ...logExtra }));

      if (body.rateLimited) {
        rateLimited.push({ action, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      const branch = body.ok ? "success" : "failed";
      const nodeId = action.nodeId as string;
      const resumed = resumeFromNode(graph, nodeId, payload, branch);
      if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), flowId || "", contentId, tenantId, env);
      if (resumed.actions.length > 0) {
        const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, payload, flowId);
        rateLimited.push(...nested.rateLimited);
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`
        ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
      }
    }
```

Replace it with (identical content, plus a new `else if` branch inserted before the loop's closing `}`):

```ts
    if (action.type === "xContentAction") {
      const operation = (action.operation as string) || "create-post";
      let res: Response;
      let logEvent: string;
      let logExtra: Record<string, unknown>;

      if (operation === "repost-post") {
        const tweetId = String(payload?.source_content_id ?? "");
        res = await fetch(`${env.LINK_URL}/internal/x/repost`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ channelId, contentId, tweetId, flowId: flowId || null }),
        });
        logEvent = "content_action_repost";
        logExtra = { channelId, tweetId };
      } else {
        const targetChannelId = action.targetChannelId as string;
        const provider = action.provider as string;
        const skillId = (action.skillId as string) || "none";
        const interpolatedPrompt = String(action.prompt || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
        res = await fetch(`${env.LINK_URL}/internal/content/create-post`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body: JSON.stringify({ contentId, interpolatedPrompt, provider, targetChannelId, flowId: flowId || null, skillId }),
        });
        logEvent = "content_action_x_content_action";
        logExtra = { targetChannelId, provider, skillId };
      }

      const body = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: logEvent, contentId, status: res.status, ok: body.ok, ...logExtra }));

      if (body.rateLimited) {
        rateLimited.push({ action, retryAt: body.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      const branch = body.ok ? "success" : "failed";
      const nodeId = action.nodeId as string;
      const resumed = resumeFromNode(graph, nodeId, payload, branch);
      if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), flowId || "", contentId, tenantId, env);
      if (resumed.actions.length > 0) {
        const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, payload, flowId);
        rateLimited.push(...nested.rateLimited);
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`
        ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
      }
    } else if (action.type === "tiktokContentAction") {
      const interpolate = (s: string) => String(s || "").replace(/\$content\.(\w+)/g, (_, field) => String(payload?.[field] ?? ""));
      const body = {
        contentId,
        channelId: action.channelId as string,
        titlePrompt: interpolate(action.titlePrompt as string),
        descriptionPrompt: interpolate(action.descriptionPrompt as string),
        textProvider: action.textProvider as string,
        textSkillId: action.textSkillId as string,
        imagePrompt: interpolate(action.imagePrompt as string),
        imageCount: action.imageCount as number,
        imageProvider: action.imageProvider as string,
        imageSkillId: action.imageSkillId as string,
        flowId: flowId || null,
      };
      const res = await fetch(`${env.LINK_URL}/internal/tiktok/photo-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
        body: JSON.stringify(body),
      });
      const respBody = await res.json().catch(() => ({ ok: false })) as { ok: boolean; rateLimited?: boolean; rateLimitReset?: string };
      console.log(JSON.stringify({ event: "content_action_tiktok_content_action", contentId, status: res.status, ok: respBody.ok, channelId: body.channelId }));

      if (respBody.rateLimited) {
        rateLimited.push({ action, retryAt: respBody.rateLimitReset || new Date(Date.now() + 15 * 60 * 1000).toISOString() });
        continue;
      }

      const branch = respBody.ok ? "success" : "failed";
      const nodeId = action.nodeId as string;
      const resumed = resumeFromNode(graph, nodeId, payload, branch);
      if (resumed.nodeLogs.length > 1) await emitContentNodeLogs(resumed.nodeLogs.slice(1), flowId || "", contentId, tenantId, env);
      if (resumed.actions.length > 0) {
        const nested = await executeContentActions(graph, resumed.actions, contentId, channelId, tenantId, env, payload, flowId);
        rateLimited.push(...nested.rateLimited);
        await env.FLOW_DB.prepare(
          `INSERT INTO content_flow_executions (id, flow_id, content_id, tenant_id, matched, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`
        ).bind(crypto.randomUUID(), flowId || "", contentId, Number(tenantId), new Date().toISOString()).run();
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flow && npx vitest run tests/unit/queue-content.test.ts`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add flow/src/index.ts flow/tests/unit/queue-content.test.ts
git commit -m "feat(flow): dispatch tiktokContentAction to link's /internal/tiktok/photo-post"
```

---

### Task 12: `flow` frontend — `tiktokContentAction` node UI

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx`
- Modify: `flow/frontend/components/Sidebar.tsx`
- Modify: `flow/frontend/nodes/ActionNode.tsx`
- Modify: `flow/frontend/store/flow-editor.ts`
- Modify: `flow/frontend/pages/FlowsPage.tsx`

**Interfaces:**
- Consumes: `api.channels.list("TIKTOK")`, `api.llmProviders.list()`, `api.skills.list()` (all existing, from `flow/frontend/lib/api.ts`).
- Produces: a draggable "TikTok Photo Post" node in the Sidebar, rendered/labeled in `ActionNode`, with default data set by `flow-editor.ts`'s `addNode`, and a full Inspector panel.

This task also fixes a pre-existing, unrelated build break: `Inspector.tsx:11` currently imports `ContentActionMetadata_X` from `../../../metadata/x`, but that export was moved to `metadata/x-byok.ts` as `ContentMetadata_X` in other in-progress work on this repo. This blocks `flow`'s frontend from building at all (`npx vite build` fails), so it must be fixed here regardless of this task's own scope, to verify anything in the browser.

- [ ] **Step 1: Fix the pre-existing broken import**

In `flow/frontend/components/Inspector.tsx`, change:

```ts
import { ContentActionMetadata_X } from "../../../metadata/x";
```

to:

```ts
import { ContentMetadata_X } from "../../../metadata/x-byok";
```

And change (a few lines below, at the `CONTENT_ACTION_OPERATIONS` constant):

```ts
const CONTENT_ACTION_OPERATIONS = ContentActionMetadata_X.filter((m) => m.flowType === "action");
```

to:

```ts
const CONTENT_ACTION_OPERATIONS = ContentMetadata_X.filter((m) => m.flowType === "action");
```

- [ ] **Step 2: Verify the frontend builds**

Run: `cd flow && npx vite build --mode development`
Expected: build succeeds (no more "ContentActionMetadata_X is not exported" error)

- [ ] **Step 3: Register the new node type in `flow-editor.ts`**

In `flow/frontend/store/flow-editor.ts`, change:

```ts
const ACTION_TYPES = ["addToList", "xAction", "xContentAction", "updateContentStatus"];
```

to:

```ts
const ACTION_TYPES = ["addToList", "xAction", "xContentAction", "tiktokContentAction", "updateContentStatus"];
```

And in `ACTION_CHANNEL_TYPE`, change:

```ts
export const ACTION_CHANNEL_TYPE: Record<string, string> = {
  xAction: "X",
};
```

to:

```ts
export const ACTION_CHANNEL_TYPE: Record<string, string> = {
  xAction: "X",
  tiktokContentAction: "TIKTOK",
};
```

And in `addNode`, add a new branch alongside the existing `xContentAction` one:

```ts
      } else if (type === "xContentAction") {
        data = { actionType: type, channelId: "", prompt: "", provider: "default" };
      } else if (type === "tiktokContentAction") {
        data = {
          actionType: type, channelId: "",
          titlePrompt: "", descriptionPrompt: "", textProvider: "default", textSkillId: "none",
          imagePrompt: "", imageCount: 1, imageProvider: "default", imageSkillId: "none",
        };
      } else if (type === "updateContentStatus") {
```

(i.e. insert the new `else if` between the existing `xContentAction` and `updateContentStatus` branches.)

- [ ] **Step 4: Register the node in `Sidebar.tsx`**

In `flow/frontend/components/Sidebar.tsx`, add after the existing `xContentAction` `DraggableItem`:

```tsx
        {visible("content") && (
          <DraggableItem type="tiktokContentAction" label="TikTok Photo Post" description="Generate images + caption and send to TikTok as a draft" color="border-accent bg-accent/50" icon="📸" />
        )}
```

- [ ] **Step 5: Register the node in `ActionNode.tsx`**

In `flow/frontend/nodes/ActionNode.tsx`, change:

```ts
const EXTERNAL_API_ACTIONS = ["xAction", "xContentAction"];
```

to:

```ts
const EXTERNAL_API_ACTIONS = ["xAction", "xContentAction", "tiktokContentAction"];
```

And add a new branch after the existing `xContentAction` block:

```ts
  } else if (actionType === "tiktokContentAction") {
    const channelId = data.channelId as string;
    label = "TikTok Photo Post";
    description = channelId ? "Target channel selected" : "Select a target channel...";
    icon = "📸";
  } else if (actionType === "updateContentStatus") {
```

- [ ] **Step 6: Register the node icon in `FlowsPage.tsx`**

In `flow/frontend/pages/FlowsPage.tsx`, change:

```ts
    if (at === "xContentAction") return FileTextIcon;
```

to:

```ts
    if (at === "xContentAction") return FileTextIcon;
    if (at === "tiktokContentAction") return FileTextIcon;
```

- [ ] **Step 7: Add the Inspector panel**

In `flow/frontend/components/Inspector.tsx`, add a dispatch branch in `ActionInspector` right after the existing `xContentAction` block:

```tsx
  if (actionType === "xContentAction") {
    return <XContentActionInspector nodeId={nodeId} data={data} />;
  }
  if (actionType === "tiktokContentAction") {
    return <TikTokContentActionInspector nodeId={nodeId} data={data} />;
  }
```

Add the new component after `XContentActionInspector`'s closing `}` (i.e. right before `function UpdateContentStatusInspector`):

```tsx
function TikTokContentActionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const { updateNodeData } = useFlowEditor();
  const [channels, setChannels] = useState<{ id: string; username: string }[]>([]);
  const [providers, setProviders] = useState<{ provider: string; model: string }[]>([]);
  const [skills, setSkills] = useState<{ id: string; label: string; hasCachedContent: boolean }[]>([]);

  useEffect(() => {
    api.channels.list("TIKTOK").then(setChannels).catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    api.llmProviders.list().then((res) => setProviders(res.providers)).catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    api.skills.list().then((res) => setSkills(res.skills)).catch(() => setSkills([]));
  }, []);

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">TikTok Photo Post</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">Target Account</Label>
          {channels.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No TikTok accounts linked</p>
          ) : (
            <Select
              value={data.channelId || ""}
              onChange={(e: SelectChange) => updateNodeData(nodeId, { channelId: e.target.value })}
              className="w-full text-sm"
            >
              <option value="">Select account...</option>
              {channels.map((ch) => <option key={ch.id} value={ch.id}>@{ch.username}</option>)}
            </Select>
          )}
        </div>

        <div>
          <Label className="text-xs block mb-1">Title Prompt</Label>
          <Textarea
            value={data.titlePrompt || ""}
            onChange={(e: TextareaChange) => updateNodeData(nodeId, { titlePrompt: e.target.value })}
            placeholder="Write a catchy title: $content.title"
            rows={2}
            className="w-full text-sm font-mono"
          />
        </div>
        <div>
          <Label className="text-xs block mb-1">Description Prompt</Label>
          <Textarea
            value={data.descriptionPrompt || ""}
            onChange={(e: TextareaChange) => updateNodeData(nodeId, { descriptionPrompt: e.target.value })}
            placeholder="Write a caption: $content.content_text"
            rows={3}
            className="w-full text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground mt-1">Use $content.title, $content.content_text etc.</p>
        </div>
        <div>
          <Label className="text-xs block mb-1">Text Provider</Label>
          <Select
            value={data.textProvider || "default"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { textProvider: e.target.value })}
            className="w-full text-sm"
          >
            <option value="default">Default (free built-in model)</option>
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>{p.provider === "openai" ? "OpenAI" : "Anthropic"} ({p.model})</option>
            ))}
            <option value="none">None (post prompt text as-is)</option>
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">Text Skill</Label>
          <Select
            value={data.textSkillId || "none"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { textSkillId: e.target.value })}
            className="w-full text-sm"
          >
            <option value="none">None (current behavior)</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.label}{!s.hasCachedContent ? " (not yet fetched)" : ""}</option>
            ))}
          </Select>
        </div>

        <div>
          <Label className="text-xs block mb-1">Image Prompt</Label>
          <Textarea
            value={data.imagePrompt || ""}
            onChange={(e: TextareaChange) => updateNodeData(nodeId, { imagePrompt: e.target.value })}
            placeholder="A photo of: $content.title"
            rows={3}
            className="w-full text-sm font-mono"
          />
        </div>
        <div>
          <Label className="text-xs block mb-1">Image Count</Label>
          <Input
            type="number"
            min={1}
            max={9}
            value={data.imageCount || 1}
            onChange={(e: InputChange) => updateNodeData(nodeId, { imageCount: Math.max(1, Math.min(9, parseInt(e.target.value) || 1)) })}
            className="w-24 text-sm"
          />
        </div>
        <div>
          <Label className="text-xs block mb-1">Image Provider</Label>
          <Select
            value={data.imageProvider || "default"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { imageProvider: e.target.value })}
            className="w-full text-sm"
          >
            <option value="default">Default (Cloudflare Workers AI)</option>
            {providers.filter((p) => p.provider === "openai").map((p) => (
              <option key={p.provider} value="openai">OpenAI (gpt-image-1)</option>
            ))}
          </Select>
        </div>
        <div>
          <Label className="text-xs block mb-1">Image Skill</Label>
          <Select
            value={data.imageSkillId || "none"}
            onChange={(e: SelectChange) => updateNodeData(nodeId, { imageSkillId: e.target.value })}
            className="w-full text-sm"
          >
            <option value="none">None (current behavior)</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>{s.label}{!s.hasCachedContent ? " (not yet fetched)" : ""}</option>
            ))}
          </Select>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Verify the frontend builds**

Run: `cd flow && npx vite build --mode development`
Expected: build succeeds with no errors

- [ ] **Step 9: Manual browser verification**

Per this repo's `CLAUDE.md` requirement ("实现完成后立即运行自测（启动 dev server、在浏览器中验证功能）"), start the local dev servers and verify in a real browser:

1. `cd flow && wrangler dev --env dev` (and equivalently for `content`/`link` if not already running against dev).
2. Open the flow editor, confirm a new "TikTok Photo Post" (📸) item appears in the Actions sidebar (only when viewing a Content Flow, matching `xContentAction`'s existing `visible("content")` gating).
3. Drag it onto the canvas, open its Inspector, confirm all 8 fields render (Target Account, Title Prompt, Description Prompt, Text Provider, Text Skill, Image Prompt, Image Count, Image Provider, Image Skill) and are editable.
4. Confirm Target Account lists only TikTok-connected channels (empty state renders correctly if none are linked in the current dev tenant).
5. Confirm Text Skill / Image Skill dropdowns list "Social (marketingskills)" (already cached from earlier work in this session).
6. Save the flow and confirm no console errors.

- [ ] **Step 10: Commit**

```bash
git add flow/frontend/components/Inspector.tsx flow/frontend/components/Sidebar.tsx flow/frontend/nodes/ActionNode.tsx flow/frontend/store/flow-editor.ts flow/frontend/pages/FlowsPage.tsx
git commit -m "feat(flow): add TikTok Photo Post node UI (Inspector, sidebar, canvas rendering)"
```

---

## Verification (full plan)

1. `cd content && npx vitest run` — all tests green, including Tasks 1-4's new files.
2. `cd link && npx vitest run` — all tests green, including Tasks 5-9's new files.
3. `cd flow && npx vitest run` — all tests green, including Tasks 10-11's new/updated files.
4. `cd flow && npx vite build --mode development` — frontend builds cleanly (confirms Task 12's Step 1 fix and the new Inspector component both compile).
5. Manual, one-time infrastructure steps (see Task 5's note and the design spec's §6): create the `MEDIA_BUCKET` R2 buckets (dev + prod) with a 48h lifecycle rule, and verify the domain serving `/public/media/*` with TikTok's domain-verification process, in each environment, before relying on this end-to-end against real TikTok.
6. Deploy `content`, `link`, `flow` to the `dev` environment (local `wrangler deploy --env dev` per this project's workflow — no GitHub Actions), then repeat Task 12 Step 9's browser walkthrough against the deployed dev environment.

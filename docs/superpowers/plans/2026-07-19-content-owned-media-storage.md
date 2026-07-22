# Content-Owned Media Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the `MEDIA_BUCKET` R2 binding and its public serving route from `link` to `content`, so `content` — the module that actually generates media — owns storage for what it produces, instead of shipping bytes to `link` purely to be stored.

**Architecture:** New R2 bucket + `CONTENT_URL` var + serving route added to `content`; `/internal/generate-image`'s contract changes from "return image bytes" to "write to R2, return `{url}`"; `link`'s TikTok photo-post route simplifies to just forward that URL; `link`'s old binding/route/types/tests are removed; old R2 buckets deleted once verified.

**Tech Stack:** Cloudflare Workers (Hono), R2, Vitest + `@cloudflare/vitest-pool-workers`, TypeScript.

## Global Constraints

- No production data exists in the current bucket — this migration does not need a data-preservation/backfill step.
- `content`'s new `GET /public/media/:key` route must be unauthenticated, matching the original `link` route exactly (no session/internal-secret check).
- The new route must be explicitly exempted from `content/src/index.ts`'s `fetch` wrapper's HTML-redirect check (line 110 today) and its ASSETS-serving-first check (line 124 today) — both currently exempt `/health` explicitly; `/public` needs the same treatment in both places, or requests to it get intercepted before Hono's router ever sees them.
- `/internal/generate-image`'s new response shape is `{ url: string }` on success (200), replacing the old raw-bytes response body. Error responses (400/502) are unchanged.
- Best-effort image-generation semantics in `link`'s TikTok photo-post route (partial failures don't fail the whole post; zero successes does) are unchanged by this migration — only the per-image mechanics change.
- Deleting the old R2 buckets (`uniscrm-link-media-dev`/`uniscrm-link-media`) is a controller-executed step (Task 4, Step 5) — never delegate actual bucket deletion to a subagent, and reconfirm immediately before running it regardless of this plan's already-recorded decision to delete.

---

## Task 1: `content` — new R2 bucket, `CONTENT_URL` var, serving route

**Files:**
- Modify: `content/wrangler.toml`
- Modify: `content/src/types.ts`
- Modify: `content/src/index.ts`
- Test: `content/tests/public-media.test.ts` (new)

**Interfaces:**
- Produces: `GET /public/media/:key` — 200 with the stored object's bytes/content-type, 404 if the key doesn't exist. `env.MEDIA_BUCKET: R2Bucket` and `env.CONTENT_URL: string` become available to the rest of `content` (Task 2 uses both).

- [ ] **Step 1: Write the failing test**

Create `content/tests/public-media.test.ts` (mirrors `link`'s original `public-media.test.ts` exactly, adapted to `content`'s domain):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/public-media.test.ts`
Expected: FAIL — `env.MEDIA_BUCKET` is `undefined` (binding doesn't exist yet in `content/wrangler.toml`), so the route (which doesn't exist yet either) can't be reached; expect a thrown error or a 404 from the route not existing.

- [ ] **Step 3: Write the implementation**

In `content/wrangler.toml`, add to `[env.dev]` (after the existing `[env.dev.ai]` block):

```toml
[[env.dev.r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "uniscrm-content-media-dev"
```

Add `CONTENT_URL` to `[env.dev.vars]` (alongside the existing `WEB_URL`):

```toml
CONTENT_URL = "https://content-dev.uni-scrm.com"
```

Add to `[env.production]` (after the existing `[env.production.ai]` block):

```toml
[[env.production.r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "uniscrm-content-media"
```

Add `CONTENT_URL` to `[env.production.vars]`:

```toml
CONTENT_URL = "https://content.uni-scrm.com"
```

In `content/src/types.ts`, add to the `Env` interface:

```ts
  MEDIA_BUCKET: R2Bucket;
  CONTENT_URL: string;
```

In `content/src/index.ts`, add the route after the existing `app.get("/health", ...)` line:

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

Update the `fetch` wrapper's two path-exclusion checks to also exempt `/public` (matching the existing `/health` treatment):

```ts
    if (accept.includes("text/html") && !url.pathname.startsWith("/api") && !url.pathname.startsWith("/internal") && !url.pathname.startsWith("/public")) {
```

```ts
    if (!url.pathname.startsWith("/api") && !url.pathname.startsWith("/internal") && !url.pathname.startsWith("/health") && !url.pathname.startsWith("/public") && env.ASSETS) {
```

(These replace the current lines 110 and 124 respectively — same lines, each gaining one more `&& !url.pathname.startsWith("/public")` clause.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/public-media.test.ts`
Expected: `Test Files 1 passed (1)`, `Tests 2 passed (2)`.

Run the full suite to confirm no regressions: `cd content && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add content/wrangler.toml content/src/types.ts content/src/index.ts content/tests/public-media.test.ts
git commit -m "feat(content): add MEDIA_BUCKET R2 binding, CONTENT_URL var, public media serving route"
```

---

## Task 2: `content` — `/internal/generate-image` writes to R2, returns `{url}`

**Files:**
- Modify: `content/src/routes-internal.ts`
- Modify: `content/tests/routes-internal.test.ts`

**Interfaces:**
- Consumes: `env.MEDIA_BUCKET`, `env.CONTENT_URL` (Task 1).
- Produces: `POST /internal/generate-image` now returns `{ url: string }` (200) instead of raw image bytes. Task 3's `link` route is the consumer of this new shape.

- [ ] **Step 1: Update the existing test to the new expected behavior**

In `content/tests/routes-internal.test.ts`, replace the `"returns image bytes with the right content-type on success (default provider, Workers AI)"` test (currently at lines 165-178) with:

```ts
  it("stores the generated image in R2 and returns its public URL on success (default provider, Workers AI)", async () => {
    const res = await worker.fetch(
      new Request("https://content-dev.uni-scrm.com/internal/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ tenantId: 999, prompt: "a lizard", provider: "default" }),
      }),
      { ...testEnv, CONTENT_URL: "https://content-dev.uni-scrm.com" }
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ url: string }>();
    expect(body.url).toMatch(/^https:\/\/content-dev\.uni-scrm\.com\/public\/media\/[0-9a-f-]+$/);

    const key = body.url.split("/").pop()!;
    const stored = await env.MEDIA_BUCKET.get(key);
    expect(stored).toBeTruthy();
    expect(stored!.httpMetadata?.contentType).toBe("image/jpeg");
    expect(new TextDecoder().decode(await stored!.arrayBuffer())).toBe("fake-jpeg-bytes");
  });
```

(This file already imports `env` from `cloudflare:test` for other describe blocks in the same file — reuse that import, don't add a duplicate.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd content && npx vitest run tests/routes-internal.test.ts`
Expected: FAIL — the route still returns raw bytes (`Content-Type: image/jpeg`, non-JSON body), so `res.json()` throws or `body.url` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `content/src/routes-internal.ts`, replace the `/generate-image` route body:

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
      const key = crypto.randomUUID();
      await c.env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
      return c.json({ url: `${c.env.CONTENT_URL}/public/media/${key}` });
    } catch (err) {
      console.error(JSON.stringify({ event: "generate_image_failed", tenantId, provider, error: String(err) }));
      return c.json({ error: "Image generation failed" }, 502);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd content && npx vitest run tests/routes-internal.test.ts`
Expected: all tests pass, including the rewritten one.

Run the full suite: `cd content && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add content/src/routes-internal.ts content/tests/routes-internal.test.ts
git commit -m "feat(content): /internal/generate-image writes to MEDIA_BUCKET, returns {url} instead of raw bytes"
```

---

## Task 3: `link` — TikTok photo-post consumes the URL directly

**Files:**
- Modify: `link/src/routes-internal.ts`
- Modify: `link/tests/services/routes-internal-tiktok-photo-post.test.ts`

**Interfaces:**
- Consumes: `content`'s new `POST /internal/generate-image` response shape, `{ url: string }` (Task 2).
- Produces: no change to this route's own external contract (`POST /internal/tiktok/photo-post` still returns the same `{ok, rateLimited?, ...}` shape) — only its internal per-image mechanics change.

- [ ] **Step 1: Update the test's mocked `content` responses**

In `link/tests/services/routes-internal-tiktok-photo-post.test.ts`:

1. Delete the `mockMediaBucket()` function (lines 41-43) entirely — `link`'s env no longer has this binding.
2. Remove `MEDIA_BUCKET: mockMediaBucket()` from both test env overrides (lines 96 and 120).
3. In the `"generates images, stores them in R2, and publishes on success..."` test's `fetchMock` implementation, change the `/internal/generate-image` branch from returning raw bytes to returning JSON:

```ts
      if (url.includes("/internal/generate-image")) {
        // First call succeeds, second call fails -- best-effort should still publish with 1 image.
        const priorCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("generate-image")).length;
        if (priorCalls === 1) {
          return new Response(JSON.stringify({ url: "https://content-dev.uni-scrm.com/public/media/fake-key-1" }), { status: 200 });
        }
        return new Response("upstream error", { status: 502 });
      }
```

4. Update the test's title (was `"generates images, stores them in R2, and publishes on success..."`) to `"generates images, forwards content's URLs, and publishes on success (best-effort: 1 of 2 images failing still succeeds)"` — it no longer stores anything in R2 itself.
5. Add an assertion that `photoUrls` (accessible via the parsed `publishBody.source_info.photo_images`) contains exactly the URL `content` returned:

```ts
    expect(publishBody.source_info.photo_images).toEqual(["https://content-dev.uni-scrm.com/public/media/fake-key-1"]);
```

(replacing the existing weaker `expect(publishBody.source_info.photo_images).toHaveLength(1);` assertion with this exact-value check, now that there's a concrete URL to assert against).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-photo-post.test.ts`
Expected: FAIL — the route still tries `res.arrayBuffer()` on a JSON response and/or calls `c.env.MEDIA_BUCKET.put(...)`, which is `undefined` in the updated test env (no `mockMediaBucket()` provided anymore), throwing.

- [ ] **Step 3: Write the implementation**

In `link/src/routes-internal.ts`, replace the per-image loop body (currently lines 383-395):

```ts
    const requestedCount = Math.max(1, Math.min(9, imageCount || 1));
    const photoUrls: string[] = [];
    for (let i = 0; i < requestedCount; i++) {
      const res = await fetch(`${c.env.CONTENT_URL}/internal/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId, prompt: prompts.message_image, provider: imageProvider, skillId: imageSkillId }),
      });
      if (!res.ok) continue;
      const body = await res.json() as { url: string };
      photoUrls.push(body.url);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/routes-internal-tiktok-photo-post.test.ts`
Expected: all tests pass, including the updated one.

Run the full `link` suite: `cd link && npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-tiktok-photo-post.test.ts
git commit -m "feat(link): TikTok photo-post forwards content's returned URL instead of storing bytes itself"
```

---

## Task 4: `link` — remove old binding, route, types, test; delete old buckets

**Files:**
- Modify: `link/wrangler.toml`
- Modify: `link/src/types.ts`
- Modify: `link/src/index.ts`
- Delete: `link/tests/services/public-media.test.ts`

**Interfaces:**
- Consumes: nothing (pure removal, plus a destructive infra step).
- Produces: `link` no longer has a `MEDIA_BUCKET` binding, no `GET /public/media/:key` route, and the old R2 buckets are deleted from Cloudflare.

- [ ] **Step 1: Delete the superseded test file**

```bash
git rm link/tests/services/public-media.test.ts
```

- [ ] **Step 2: Remove the route and binding**

In `link/src/index.ts`, remove the `GET /public/media/:key` route entirely (the block matching Task 1's Step 3 code, now living in `content` instead).

In `link/src/types.ts`, remove the `MEDIA_BUCKET: R2Bucket;` line from the `Env` interface.

In `link/wrangler.toml`, remove both `[[r2_buckets]]` blocks (the `env.dev` one and the `env.production` one).

- [ ] **Step 3: Run the full `link` suite to confirm nothing else references the removed binding**

Run: `cd link && npx vitest run`
Expected: all tests pass (Task 3 already updated the one test file that referenced `MEDIA_BUCKET`; this step is a final confirmation no other test or source file still references it).

Also run `cd link && npx tsc --noEmit` and confirm no new type errors reference `MEDIA_BUCKET` or the removed route (some pre-existing, unrelated type-check noise elsewhere in the repo is expected and not this task's concern).

- [ ] **Step 4: Commit the code removal**

```bash
git add link/src/index.ts link/src/types.ts link/wrangler.toml
git commit -m "feat(link): remove MEDIA_BUCKET binding and public media route (relocated to content)"
```

- [ ] **Step 5: Deploy both modules to dev and verify, then delete the old R2 buckets**

This step is executed directly by the controller (not a subagent), and the actual deletion command is reconfirmed with the user immediately before running it, regardless of this plan's recorded decision to delete:

```bash
cd content && wrangler deploy --env dev
cd link && wrangler deploy --env dev
```

Manually trigger a TikTok photo-post generation against the dev tenant (or via the existing flow UI) and confirm the produced photo URLs point at `content-dev.uni-scrm.com/public/media/...` and are fetchable (`curl -I <url>` returns 200).

Once confirmed working, delete the old buckets:

```bash
wrangler r2 bucket delete uniscrm-link-media-dev
wrangler r2 bucket delete uniscrm-link-media
```

(Requires re-confirmation immediately before running, per this plan's Global Constraints — do not run this automatically without that final check.)

## Verification (after all tasks)

1. `cd content && npx vitest run`, `cd link && npx vitest run` — full suites green.
2. `grep -rn "uniscrm-link-media" .` (excluding `docs/superpowers/plans/2026-07-16-*` and `docs/superpowers/specs/2026-07-16-*`, which are historical) returns nothing — confirms no lingering reference to the old bucket names anywhere in live code.
3. Deploy both modules to dev, manually trigger a TikTok photo-post, confirm the resulting image URL resolves against `content-dev.uni-scrm.com` and is fetchable.
4. Delete the old R2 buckets per Task 4 Step 5, after the above manual verification succeeds and after re-confirming with the user immediately before running the delete commands.

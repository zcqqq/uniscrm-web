# Channel Node Panel Layout + Operation Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the Operation picker above the Account picker in the X/TikTok Content Action edit panels, and inject node-operation metadata (label + description) into the LLM system prompt for all text generations tied to a node operation.

**Architecture:** Frontend-only JSX reorder in `flow/frontend/components/Inspector.tsx`. Backend: `content`'s `generateContent` gains an optional `operationContext` string that is prepended to the system prompt (before skill content); `link`'s three `/internal/generate` call sites build that string from shared metadata via one helper.

**Tech Stack:** React (flow frontend), Hono Workers (link/content), vitest (`@cloudflare/vitest-pool-workers`), shared `metadata/` module.

**Spec:** `docs/superpowers/specs/2026-08-09-channel-node-layout-operation-context-design.md`

## Global Constraints

- Prompt format (user-approved, exact): `You are executing the flow operation: "<NodeLabel> - <label.en>" — <description.en>`
- Node labels are fixed strings at each call site: `"X Content Action"`, `"TikTok Content Action"`. Link must NOT import flow's nodeTypeRegistry.
- Inject ONLY operation-level metadata. No prop-level (title/description field) metadata. No image-generation changes.
- System prompt composition order: operation context FIRST, skill content second, joined by `"\n\n"`; `undefined` when both absent (current behavior preserved).
- Repo rules: stage exact file paths only (never `git add -A`); commit to local `main`, do NOT push; deploy dev only via `npm run deploy:dev` from the module directory.
- No `@testing-library/react` / DOM in this repo's test runners (documented in `flow/tests/unit/select-props-value-prefix.test.tsx`) — the JSX reorder is verified by test-suite pass + dev-deploy browser check, not a render test.

---

### Task 1: content — `operationContext` in generateContent and /internal/generate

**Files:**
- Modify: `content/src/services/generate.ts`
- Modify: `content/src/routes-internal.ts` (the `/generate` route, ~line 10-32)
- Test: `content/tests/generate.test.ts`

**Interfaces:**
- Consumes: existing `generateContent(env, params)`; `WorkersAiProvider.generate(prompt, model, systemPrompt?)` builds `[{role:"system"},{role:"user"}]` when systemPrompt is non-empty.
- Produces: `GenerateParams.operationContext?: string`; POST `/internal/generate` accepts optional body field `operationContext: string`. Task 2 relies on this field name exactly.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("generateContent", ...)` block in `content/tests/generate.test.ts` (reuse the file's existing `baseParams`, mock patterns):

```ts
  it("passes operationContext as the system prompt when no skill is set", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
      ...baseParams,
      operationContext: 'You are executing the flow operation: "X Content Action - Create Post" — Publish a new post via the triggering channel',
    });

    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          { role: "system", content: 'You are executing the flow operation: "X Content Action - Create Post" — Publish a new post via the triggering channel' },
          { role: "user", content: baseParams.prompt },
        ],
      })
    );
  });

  it("puts operationContext BEFORE skill content when both are present", async () => {
    vi.spyOn(skillContentModule, "getSkillContent").mockResolvedValue("Skill guidance here");
    const aiRun = vi.fn().mockResolvedValue({ response: "punchy text" });
    const mockDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };

    await generateContent({ AI: { run: aiRun }, CONTENT_DB: mockDb } as any, {
      ...baseParams,
      skillId: "marketingskills-social",
      operationContext: "op context line",
    });

    expect(aiRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([
          { role: "system", content: "op context line\n\nSkill guidance here" },
        ]),
      })
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `content/`): `npx vitest run tests/generate.test.ts`
Expected: the 2 new tests FAIL (no system message / wrong content); all pre-existing tests PASS.

- [ ] **Step 3: Implement in `content/src/services/generate.ts`**

Replace the `GenerateParams` interface and the systemPrompt computation:

```ts
export interface GenerateParams {
  tenantId: number;
  prompt: string;
  provider: "default" | "openai" | "anthropic";
  skillId?: string;
  operationContext?: string;
}

export async function generateContent(env: Env, params: GenerateParams): Promise<string> {
  const skillContent = params.skillId && params.skillId !== "none"
    ? (await getSkillContent(env, params.skillId)) ?? undefined
    : undefined;
  const systemPrompt = [params.operationContext, skillContent].filter(Boolean).join("\n\n") || undefined;
  // ... rest unchanged: every `generate(params.prompt, model, systemPrompt)` call keeps
  // passing the same `systemPrompt` variable.
```

(The rest of the function body is unchanged — only the first statement is replaced by the two statements above.)

- [ ] **Step 4: Pass the field through in `content/src/routes-internal.ts` `/generate`**

```ts
    const { tenantId, prompt, provider, skillId, operationContext } = await c.req.json<{
      tenantId: number;
      prompt: string;
      provider: "default" | "openai" | "anthropic";
      skillId?: string;
      operationContext?: string;
    }>();
    // ...
      const text = await generateContent(c.env, { tenantId, prompt, provider, skillId, operationContext });
```

(Only the destructuring, the generic type, and the `generateContent` call change; guards and error handling stay as-is. `/generate-image` is untouched.)

- [ ] **Step 5: Run the content TS suite**

Run (from `content/`): `npx vitest run`
Expected: all tests PASS (a trailing "close timed out after 10000ms" message after the summary is a known harmless artifact in this module).

- [ ] **Step 6: Commit**

```bash
git add content/src/services/generate.ts content/src/routes-internal.ts content/tests/generate.test.ts
git commit -m "feat(content): accept operationContext and prepend it to the LLM system prompt"
```

---

### Task 2: link — build operationContext from metadata at all 3 text-generation call sites

**Files:**
- Modify: `link/src/routes-internal.ts` (helper near top; call sites at ~line 651 `/internal/content/create-post`, ~line 879 tiktok photo-post `generateText`, ~line 980 tiktok video-post `generateText`)
- Test: `link/tests/services/routes-internal-content.test.ts`
- Test: `link/tests/services/routes-internal-tiktok-photo-post.test.ts`
- Test: `link/tests/services/routes-internal-tiktok-video-post.test.ts`

**Interfaces:**
- Consumes: Task 1's `/internal/generate` optional body field `operationContext: string`; metadata entries in `metadata/x-byok.ts` (`sourceContentType: "create-post"`, label `Create Post`, description `Publish a new post via the triggering channel`) and `metadata/tiktok.ts` (`photo-post` label `Photo Posting`; `video-post` label `Video Posting`).
- Produces: module-private `buildOperationContext(nodeLabel: string, sourceContentType: string, catalog: ContentOpMeta[]): string` in `link/src/routes-internal.ts`. Not exported; asserted via route behavior.

- [ ] **Step 1: Write the failing assertions/tests**

(a) In `link/tests/services/routes-internal-content.test.ts`, in the existing test `"...forwarded through to content's /internal/generate"` (~line 331), add right after the `skillId` assertion:

```ts
    expect(generateCallBody.operationContext).toBe(
      'You are executing the flow operation: "X Content Action - Create Post" — Publish a new post via the triggering channel'
    );
```

(b) In `link/tests/services/routes-internal-tiktok-photo-post.test.ts`, add a new test inside the describe block (reuses the file's `mockLinkDb`/`mockWebDb`/`withFakeD1`/`mockPipelineContent`/`channelRow`/`baseBody`):

```ts
  it("sends the photo-post operation metadata as operationContext to content's /internal/generate", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/internal/generate-image")) {
        return new Response(JSON.stringify({ url: "https://content-dev.uni-scrm.com/public/media/fake-key-1" }), { status: 200 });
      }
      if (String(url).includes("/internal/generate")) {
        return new Response(JSON.stringify({ text: "generated text" }), { status: 200 });
      }
      if (String(url).includes("/v2/post/publish/content/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub-1" }, error: { code: "ok", message: "" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/photo-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "test-internal-secret" },
        body: JSON.stringify({ ...baseBody, textProvider: "default" as const, imageCount: 1 }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: mockPipelineContent() } as any
    );

    expect(res.status).toBe(200);
    const textCalls = fetchMock.mock.calls.filter(
      (c: any[]) => String(c[0]).includes("/internal/generate") && !String(c[0]).includes("generate-image")
    );
    expect(textCalls.length).toBe(2); // title + description
    for (const call of textCalls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.operationContext).toBe(
        'You are executing the flow operation: "TikTok Content Action - Photo Posting" — Generates images and a caption from the triggering content and posts as a TikTok draft.'
      );
    }
    vi.unstubAllGlobals();
  });
```

NOTE: `/internal/generate-image` also contains the substring `/internal/generate` — the mock MUST check `generate-image` first (as written above) and the assertion filter MUST exclude it (as written above).

(c) In `link/tests/services/routes-internal-tiktok-video-post.test.ts`, add a new test inside the describe block:

```ts
  it("sends the video-post operation metadata as operationContext to content's /internal/generate", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/internal/generate")) {
        return new Response(JSON.stringify({ text: "generated caption" }), { status: 200 });
      }
      if (String(url).includes("/v2/post/publish/inbox/video/init/")) {
        return new Response(JSON.stringify({ data: { publish_id: "pub-vid-1" }, error: { code: "ok", message: "" } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", withFakeD1(fetchMock));

    const res = await worker.fetch(
      new Request("https://link-dev.uni-scrm.com/internal/tiktok/video-post", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": testSecret },
        body: JSON.stringify({ ...baseBody, textProvider: "default" as const }),
      }),
      { ...testEnv, LINK_DB: mockLinkDb(channelRow), PIPELINE_CONTENT: mockPipelineContent() }
    );

    expect(res.status).toBe(200);
    const genCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes("/internal/generate"));
    const body = JSON.parse((genCall![1] as RequestInit).body as string);
    expect(body.operationContext).toBe(
      'You are executing the flow operation: "TikTok Content Action - Video Posting" — Posts the content flow\'s processed video to TikTok as a draft.'
    );
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `link/`):
`npx vitest run tests/services/routes-internal-content.test.ts tests/services/routes-internal-tiktok-photo-post.test.ts tests/services/routes-internal-tiktok-video-post.test.ts`
Expected: the 3 new/extended tests FAIL on the `operationContext` assertions (field is `undefined`); everything else PASSES.

- [ ] **Step 3: Implement in `link/src/routes-internal.ts`**

Add imports (top of file, alongside the existing `EventMetadata_X` import):

```ts
import { ContentMetadata_X } from "../../metadata/x-byok";
import { ContentMetadata_TikTok } from "../../metadata/tiktok";
import type { LocalizedString } from "../../metadata/dataTypes";
```

Add the helper after the import block (module scope):

```ts
// User-approved system-prompt line for LLM-backed node operations (spec 2026-08-09):
// operation-level metadata only — prop-level metadata is the user's own prompt's business.
type ContentOpMeta = { sourceContentType: string; label?: LocalizedString; description?: LocalizedString };
function buildOperationContext(nodeLabel: string, sourceContentType: string, catalog: ContentOpMeta[]): string {
  const meta = catalog.find((m) => m.sourceContentType === sourceContentType);
  const opLabel = meta?.label?.en ?? sourceContentType;
  const desc = meta?.description?.en;
  return `You are executing the flow operation: "${nodeLabel} - ${opLabel}"${desc ? ` — ${desc}` : ""}`;
}
```

Call site 1 — `/internal/content/create-post` (~line 651), extend the fetch body:

```ts
        body: JSON.stringify({
          tenantId: channel.tenant_id,
          prompt: interpolatedPrompt,
          provider,
          skillId,
          operationContext: buildOperationContext("X Content Action", "create-post", ContentMetadata_X),
        }),
```

Call site 2 — tiktok photo-post `generateText` (~line 879): compute once above the closure, include in body:

```ts
    const operationContext = buildOperationContext("TikTok Content Action", "photo-post", ContentMetadata_TikTok);
    const generateText = async (prompt: string): Promise<string | null> => {
      if (textProvider === "none") return prompt;
      const res = await fetch(`${c.env.CONTENT_URL}/internal/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId, prompt, provider: textProvider, skillId: textSkillId, operationContext }),
      });
      if (!res.ok) return null;
      const body = await res.json<{ text: string }>();
      return body.text;
    };
```

Call site 3 — tiktok video-post `generateText` (~line 980): identical shape with `"video-post"`:

```ts
    const operationContext = buildOperationContext("TikTok Content Action", "video-post", ContentMetadata_TikTok);
    const generateText = async (prompt: string): Promise<string | null> => {
      if (textProvider === "none") return prompt;
      const res = await fetch(`${c.env.CONTENT_URL}/internal/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": c.env.INTERNAL_SECRET },
        body: JSON.stringify({ tenantId, prompt, provider: textProvider, skillId: textSkillId, operationContext }),
      });
      if (!res.ok) return null;
      const body = await res.json<{ text: string }>();
      return body.text;
    };
```

(`LocalizedString` is verified exported from `metadata/dataTypes.ts:12` as `{ en: string; zh: string }`.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `link/`):
`npx vitest run tests/services/routes-internal-content.test.ts tests/services/routes-internal-tiktok-photo-post.test.ts tests/services/routes-internal-tiktok-video-post.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Run the full link suite**

Run (from `link/`): `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-content.test.ts link/tests/services/routes-internal-tiktok-photo-post.test.ts link/tests/services/routes-internal-tiktok-video-post.test.ts
git commit -m "feat(link): send node-operation metadata as operationContext to content generate"
```

---

### Task 3: flow frontend — Operation above Account in X/TikTok Content Action panels

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx` (`XContentActionInspector` ~lines 911-943; `TikTokContentActionInspector` ~lines 1210-1241)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (independent).
- Produces: nothing consumed later. Pure JSX reorder — no state, handler, or prop changes.

- [ ] **Step 1: Reorder `XContentActionInspector`**

Inside its `<div className="space-y-3">`, move the entire Operation `<div>` block (the one containing `<OperationSelect value={data.operation || "create-post"} ...>`) so it is the FIRST child, above the Target Account `<div>` block (the one containing the `channels.length === 0` ternary). Both blocks move verbatim — no attribute or handler edits. The `{aiProp && ...}` / `{videoProp && ...}` blocks stay after both, unchanged.

Resulting child order: Operation → Target Account → `{aiProp && ...}` → `{videoProp && ...}`.

- [ ] **Step 2: Reorder `TikTokContentActionInspector`**

Same edit: move the Operation `<div>` block (containing `<OperationSelect value={operation} ... CONTENT_TIKTOK_ACTION_OPERATIONS ...>`) above the Target Account `<div>` block. Everything after (textProps map, provider/skill selects, image section) stays unchanged.

Resulting child order: Operation → Target Account → text prompts → providers/skills → image section.

- [ ] **Step 3: Run the flow suite (regression only — no DOM tests exist, see Global Constraints)**

Run (from `flow/`): `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/components/Inspector.tsx
git commit -m "feat(flow): show Operation above Account in X/TikTok Content Action panels"
```

---

### Task 4: Deploy dev and verify

**Files:** none (deployment + verification only)

**Interfaces:**
- Consumes: Tasks 1-3 committed.

- [ ] **Step 1: Deploy the three modules to dev**

From each module directory, in this order (content and link have no interdependency; flow's UI is what gets browser-checked):

```bash
cd content && npm run deploy:dev
cd ../link && npm run deploy:dev
cd ../flow && npm run deploy:dev
```

Expected: each prints a successful wrangler deploy for the `-dev` worker. (Never bare `wrangler deploy` — it hits PROD and strips bindings.)

- [ ] **Step 2: Browser-verify the panel layout**

Using the already-logged-in Chrome session (claude-in-chrome; reuse the real session via `tabs_context_mcp`, don't fabricate accounts): open `https://flow-dev.uni-scrm.com`, open a content flow (or create a throwaway one), click an X Content Action node → confirm the edit panel shows 操作/Operation first, 目标账号/Target Account second. Repeat for a TikTok Content Action node. If session expired, click "Continue with Google" on the dev login page (user-authorized).

- [ ] **Step 3: Verify prompt injection evidence**

The unit tests are the functional proof (no real tweet is posted). As a deploy sanity check, hit content-dev's generate through the internal route is not directly possible without the secret from shell — instead confirm the deploy picked up the new code by the vitest-verified behavior plus `wrangler tail` (optional, only if something looks off in Step 2).

- [ ] **Step 4: Report**

Report completion to the user: panel order screenshots/confirmation, test counts, deployed workers, commit hashes. Do NOT push.

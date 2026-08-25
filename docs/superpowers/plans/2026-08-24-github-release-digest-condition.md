# GitHub Release Digest Condition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `githubContentTrigger` flow combine every release published within a rolling window into one downstream action, via a new `githubCondition` node that mirrors the existing `youtubeCondition` pattern (trigger → wait → recheck-and-branch).

**Architecture:** Every release still enters the flow independently and starts its own `wait`. When a wait resumes, the new `githubCondition` node re-fetches the repo's current release list from GitHub through a new synchronous link endpoint, and only the chain belonging to the most-recently-published release in a configurable window (`maxWaitDays`) is allowed to reach the action node. A single config number drives both the recheck window and a force-fire safety cap — see the spec's "Why one window number, not two" for the concrete scenario that ruled out a second, narrower window.

**Tech Stack:** Cloudflare Workers (`flow`, `link`), D1, TypeScript, Vitest. Reuses the existing trigger→wait→condition resume pipeline (`content_flow_pending`) — no new D1 table.

**Spec:** `docs/superpowers/specs/2026-08-24-github-release-digest-condition-design.md`

## Global Constraints

- `release_count_1d`/`release_notes_1d` (shipped separately, commit `1262cc9`) are untouched.
- `githubCondition`'s field list is sourced the same way `youtubeCondition`'s is — shared with the trigger's own `ContentMetadata_GitHub` registry entry, not a separate node-scoped list (spec Component 0).
- A single `maxWaitDays` node config value drives both the recheck window and the force-fire cap (spec "Why one window number, not two").
- Never guess: a GitHub API failure (rate-limited, repo unreadable, network/5xx) always resolves to the `failed` branch, never a guessed `true`/`false`.
- Push to `main` only on explicit instruction; `npm run deploy:dev` for dev verification, never bare `wrangler deploy`.

**Implementation refinement vs. the spec (decided while writing this plan, not a spec change):** the spec's Error Handling section mentions failing when "the resuming release no longer appears in the freshly fetched list." Working through it concretely: the recheck only ever needs the *caller-supplied* `publishedAt` (from the flow's own stored payload) compared against the freshly fetched window's latest `published_at` — it never needs to re-find the release by id in GitHub's response. Dropping that lookup removes a whole edge case (a deleted release) without weakening the "never guess" principle: a real GitHub API failure still fails closed via `listReleases`'s existing `rateLimited`/`notFound`/thrown-error surface, unchanged.

---

### Task 1: Link — `buildReleaseWindow` + `isLatestRelease`

**Files:**
- Create: `link/src/services/github-release-window.ts`
- Test: `link/tests/services/github-release-window.test.ts`

**Interfaces:**
- Consumes: `GitHubRelease` type and `resolveProps` (`link/src/services/pollers/resolve-props.ts`), `ContentMetadata_GitHub` (`metadata/github.ts`) — same imports `link/src/services/pollers/github-releases.ts` already uses.
- Produces: `ReleaseWindowEntry { published_at: string; title: string; content_text: string }`, `buildReleaseWindow(releases: GitHubRelease[], maxWaitDays: number, includePrerelease: boolean, now: number): ReleaseWindowEntry[]`, `isLatestRelease(window: { published_at: string }[], publishedAt: string, maxWaitDays: number, now: number): boolean`. Task 2 imports both.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { buildReleaseWindow, isLatestRelease } from "../../src/services/github-release-window";

const NOW = Date.parse("2026-08-24T00:00:00Z");

function rel(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, tag_name: "v1", name: "v1", body: "notes", html_url: "https://gh/r/v1",
    draft: false, prerelease: false,
    published_at: "2026-08-23T00:00:00Z", created_at: "2026-08-23T00:00:00Z",
    ...over,
  };
}

describe("buildReleaseWindow", () => {
  it("只留 maxWaitDays 天内、有 published_at 的条目，带 title/content_text", () => {
    const w = buildReleaseWindow(
      [
        rel({ published_at: "2026-08-23T00:00:00Z" }),               // 1 天内
        rel({ published_at: "2026-08-10T00:00:00Z" }),                // 超出 maxWaitDays=7
        rel({ published_at: null }),                                   // 无发布时间
      ] as never,
      7, false, NOW
    );
    expect(w).toEqual([{ published_at: "2026-08-23T00:00:00Z", title: "v1", content_text: "notes" }]);
  });

  it("默认按 includePrerelease 过滤", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", prerelease: true })] as never,
      7, false, NOW
    );
    expect(w).toEqual([]);
    const w2 = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", prerelease: true })] as never,
      7, true, NOW
    );
    expect(w2).toHaveLength(1);
  });

  it("title 为空时回退 tag_name，和轮询器主路径一致", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", name: null, tag_name: "v1.3.14" })] as never,
      7, false, NOW
    );
    expect(w[0].title).toBe("v1.3.14");
  });

  it("draft 跳过", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", draft: true })] as never,
      7, false, NOW
    );
    expect(w).toEqual([]);
  });

  it("单条正文超过 2000 字截断", () => {
    const w = buildReleaseWindow(
      [rel({ published_at: "2026-08-23T00:00:00Z", body: "x".repeat(5_000) })] as never,
      7, false, NOW
    );
    expect(w[0].content_text).toHaveLength(2_000);
  });

  it("累计字节预算耗尽后，后续条目整条不出现（不像 release_history 那样退回空文本形状——这里没有别的用途要保留它们）", () => {
    const releases = Array.from({ length: 40 }, (_, i) =>
      rel({ id: i, published_at: "2026-08-23T00:00:00Z", body: "x".repeat(2_000) })
    );
    const w = buildReleaseWindow(releases as never, 7, false, NOW);
    expect(w.length).toBeGreaterThan(0);
    expect(w.length).toBeLessThan(40);
  });
});

describe("isLatestRelease", () => {
  const window = [
    { published_at: "2026-08-23T00:00:00Z" },
    { published_at: "2026-08-22T00:00:00Z" },
  ];

  it("我的发布时间是窗口里最晚的 → true", () => {
    expect(isLatestRelease(window, "2026-08-23T00:00:00Z", 7, NOW)).toBe(true);
  });

  it("窗口里有更晚的 → false", () => {
    expect(isLatestRelease(window, "2026-08-22T00:00:00Z", 7, NOW)).toBe(false);
  });

  it("超过 maxWaitDays 强制 true，不管是不是最新", () => {
    const old = Date.parse("2026-08-10T00:00:00Z"); // 14 天前
    expect(isLatestRelease(window, new Date(old).toISOString(), 7, NOW)).toBe(true);
  });

  it("空窗口（我自己都不在里面）时，只要没超 cap 就算最新", () => {
    expect(isLatestRelease([], "2026-08-23T00:00:00Z", 7, NOW)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/services/github-release-window.test.ts`
Expected: FAIL — `buildReleaseWindow`/`isLatestRelease` not defined (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
import type { GitHubRelease } from "./github-api";
import { resolveProps } from "./pollers/resolve-props";
import { ContentMetadata_GitHub } from "../../../metadata/github";

const GITHUB_METADATA = ContentMetadata_GitHub.find((m) => m.sourceContentType === "watch:get-releases")!;

// 单条正文上限——比 release_history 的 2000 更宽松没有必要：这里同样要给下面的累计字节
// 预算和 HTTP 响应体大小留余量，道理和 github-releases.ts 的 MAX_HISTORY_ENTRY_TEXT 一样，
// 只是这是一次同步请求/响应，不是 Queues 消息，独立定数字。
const MAX_ENTRY_TEXT = 2_000;

// 累计 UTF-8 字节预算（中文最坏 3 倍/字符）。maxWaitDays 天内正常只有个位数 release，
// 这个预算几乎用不到；真遇到病态高频发版，超预算的条目整条不进窗口——与
// release_history 的"退回不带文本的形状"不同：这个窗口只有一个用途（拼进
// release_notes_window），没有文本就没有存在的意义，不像 release_history 里空文本
// 条目还要继续贡献计数。
const TEXT_BUDGET_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

export interface ReleaseWindowEntry {
  published_at: string;
  title: string;
  content_text: string;
}

export function buildReleaseWindow(
  releases: GitHubRelease[],
  maxWaitDays: number,
  includePrerelease: boolean,
  now: number
): ReleaseWindowEntry[] {
  const windowMs = maxWaitDays * 24 * 60 * 60 * 1000;
  let textBudget = TEXT_BUDGET_BYTES;
  const out: ReleaseWindowEntry[] = [];

  for (const r of releases) {
    if (r.draft || r.published_at === null) continue;
    if (!includePrerelease && r.prerelease === true) continue;
    if (now - Date.parse(r.published_at as string) > windowMs) continue;

    const resolved = resolveProps(r as unknown as Record<string, unknown>, GITHUB_METADATA.contentProps);
    const title = String(resolved.title || r.tag_name || "").slice(0, MAX_ENTRY_TEXT);
    const contentText = String(resolved.content_text || "").slice(0, MAX_ENTRY_TEXT);
    const cost = textEncoder.encode(title + contentText).length;
    if (cost > textBudget) continue;
    textBudget -= cost;

    out.push({ published_at: r.published_at as string, title, content_text: contentText });
  }

  return out;
}

// 单一个 maxWaitDays 同时做两件事：往回看多久算"是否最新"，以及强制发帖的上限。
// 见 spec「Why one window number, not two」——分开两个数字会让 notes 悄悄漏内容。
export function isLatestRelease(
  window: { published_at: string }[],
  publishedAt: string,
  maxWaitDays: number,
  now: number
): boolean {
  const capMs = maxWaitDays * 24 * 60 * 60 * 1000;
  if (now - Date.parse(publishedAt) > capMs) return true;
  const maxPublishedAt = window.reduce((max, r) => Math.max(max, Date.parse(r.published_at)), -Infinity);
  return Date.parse(publishedAt) >= maxPublishedAt;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/services/github-release-window.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add link/src/services/github-release-window.ts link/tests/services/github-release-window.test.ts
git commit -m "feat(link): add buildReleaseWindow/isLatestRelease for GitHub release digest"
```

---

### Task 2: Link — `POST /internal/github/release-recheck`

**Files:**
- Modify: `link/src/routes-internal.ts` (add `boundedGitHubReason` near `boundedYouTubeReason` at line 230, add the route near `/youtube/video-stats` at line 832)
- Test: `link/tests/services/routes-internal-github-release-recheck.test.ts`

**Interfaces:**
- Consumes: `buildReleaseWindow`, `isLatestRelease` (Task 1); `listReleases` (`link/src/services/github-api.ts`, existing).
- Produces: `POST /internal/github/release-recheck` — request `{ channelId, repoFullName, includePrerelease, maxWaitDays, sourceContentId, publishedAt, contentId, flowId }`, success response `{ ok: true, props: { release_count_window: number, release_notes_window: string, is_latest_release: 0|1 } }`, failure `{ ok: false, reason: string }`. Task 5 (flow side) calls this exact shape.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";

const listReleasesMock = vi.fn();
vi.mock("../../src/services/github-api", async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  listReleases: (...a: unknown[]) => listReleasesMock(...a),
}));

function rel(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1, tag_name: "v1", name: "v1", body: "notes", html_url: "https://gh/r/v1",
    draft: false, prerelease: false,
    published_at: new Date().toISOString(), created_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(async () => {
  listReleasesMock.mockReset();
  await env.LINK_DB.prepare(
    `INSERT INTO channels (id, tenant_id, channel_type, config, is_active)
     VALUES ('gh-chan', 1, 'GITHUB', ?, 1)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config`
  ).bind(JSON.stringify({ access_token: "tok" })).run();
});

async function recheck(body: Record<string, unknown>) {
  return SELF.fetch("https://link.test/internal/github/release-recheck", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": (env as any).INTERNAL_SECRET },
    body: JSON.stringify(body),
  });
}

describe("POST /internal/github/release-recheck", () => {
  it("返回新鲜的 release_count_window/release_notes_window/is_latest_release", async () => {
    listReleasesMock.mockResolvedValue({
      releases: [rel({ id: 1, published_at: new Date().toISOString(), name: "v1.4.0", body: "dark mode" })],
      etag: null, rateLimited: false, notFound: false,
    });

    const res = await recheck({
      channelId: "gh-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "1", publishedAt: new Date().toISOString(), contentId: "c1", flowId: "f1",
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; props: { release_count_window: number; release_notes_window: string; is_latest_release: number } };
    expect(body.ok).toBe(true);
    expect(body.props.release_count_window).toBe(1);
    expect(JSON.parse(body.props.release_notes_window)).toEqual([{ title: "v1.4.0", content_text: "dark mode" }]);
    expect(body.props.is_latest_release).toBe(1);
  });

  it("我不是窗口里最新的 → is_latest_release: 0", async () => {
    const now = Date.now();
    listReleasesMock.mockResolvedValue({
      releases: [
        rel({ id: 1, published_at: new Date(now).toISOString() }),
        rel({ id: 2, published_at: new Date(now - 60 * 60 * 1000).toISOString() }),
      ],
      etag: null, rateLimited: false, notFound: false,
    });

    const res = await recheck({
      channelId: "gh-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "2", publishedAt: new Date(now - 60 * 60 * 1000).toISOString(), contentId: "c1", flowId: "f1",
    });

    const body = await res.json() as { props: { is_latest_release: number } };
    expect(body.props.is_latest_release).toBe(0);
  });

  it("限流 → ok:false, reason: rate_limited", async () => {
    listReleasesMock.mockResolvedValue({ releases: null, etag: null, rateLimited: true, notFound: false });
    const res = await recheck({
      channelId: "gh-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "1", publishedAt: new Date().toISOString(), contentId: "c1", flowId: "f1",
    });
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("rate_limited");
  });

  it("repo 读不到 → ok:false, reason: repo_unavailable", async () => {
    listReleasesMock.mockResolvedValue({ releases: null, etag: null, rateLimited: false, notFound: true });
    const res = await recheck({
      channelId: "gh-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "1", publishedAt: new Date().toISOString(), contentId: "c1", flowId: "f1",
    });
    const body = await res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("repo_unavailable");
  });

  it("channel 没有 GitHub token → ok:false", async () => {
    const res = await recheck({
      channelId: "no-such-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "1", publishedAt: new Date().toISOString(), contentId: "c1", flowId: "f1",
    });
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});
```

Check the file this test lives beside (`link/tests/services/routes-internal-content.test.ts` or similar) for the exact `SELF`/`env` test-harness setup (how `INTERNAL_SECRET` header and the Hono app are wired into `cloudflare:test`) and match it — this plan's snippet above assumes the same harness every other `routes-internal.ts` test file uses; adjust the request helper to match if that file wires it differently (e.g. importing the Hono `app` directly instead of `SELF.fetch`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd link && npx vitest run tests/services/routes-internal-github-release-recheck.test.ts`
Expected: FAIL — 404 (route doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Add near `boundedYouTubeReason` (line 230 of `link/src/routes-internal.ts`):

```typescript
// listReleases/getRepo throw `listReleases(<repo>) failed <status>: <body>` / `getRepo(<repo>)
// failed <status>: <body>` (github-api.ts) — same reasoning as boundedYouTubeReason: strip the
// full response body (raw external payloads don't belong in D1/content_flow_log), keep only
// what's diagnosable.
export function boundedGitHubReason(e: unknown): string {
  const m = /(?:listReleases|getRepo)\(([\w./-]+)\) failed (\d{3})\b/.exec(String(e instanceof Error ? e.message : e));
  if (!m) return "github_api_error: request failed";
  const [, repo, status] = m;
  return `github_api_error: ${repo} HTTP ${status}`;
}
```

Add the route near `/youtube/video-stats` (after line 881's closing `});`), with imports added at the top of the file (`listReleases` from `./services/github-api`, `buildReleaseWindow`/`isLatestRelease` from `./services/github-release-window`):

```typescript
  // githubCondition 节点用它做"发布若干天后（或更多 release 陆续到来后）复查"。
  // 走 channel 自己的 GitHub token（不是 API key），channels.config.access_token 明文存储，
  // 与 cron.ts 解析 channel token 的方式一致。
  router.post("/github/release-recheck", async (c) => {
    const { channelId, repoFullName, includePrerelease, maxWaitDays, sourceContentId, publishedAt, contentId, flowId } = await c.req
      .json<{
        channelId?: string; repoFullName?: string; includePrerelease?: boolean; maxWaitDays?: number;
        sourceContentId?: string; publishedAt?: string; contentId?: string; flowId?: string | null;
      }>()
      .catch(() => ({}) as Record<string, never>);

    if (!channelId || !repoFullName || !publishedAt) {
      return c.json({ ok: false, reason: "release_unavailable: missing channelId/repoFullName/publishedAt" }, 400);
    }

    const channel = await c.env.LINK_DB
      .prepare("SELECT config FROM channels WHERE id = ? AND channel_type = 'GITHUB' AND is_active = 1")
      .bind(channelId)
      .first<{ config: string }>();
    const token = channel ? (JSON.parse(channel.config) as { access_token?: string }).access_token : undefined;
    if (!token) {
      console.log(JSON.stringify({ event: "github_release_recheck_no_token", channelId, repoFullName, contentId: contentId || null, flowId: flowId || null }));
      return c.json({ ok: false, reason: "channel_not_authorized: no GitHub token on this channel" });
    }

    let releases: Awaited<ReturnType<typeof listReleases>>["releases"];
    try {
      const r = await listReleases(token, repoFullName, null);
      if (r.rateLimited) return c.json({ ok: false, reason: "rate_limited" });
      if (r.notFound || r.releases === null) return c.json({ ok: false, reason: "repo_unavailable: not found or no access" });
      releases = r.releases;
    } catch (e) {
      console.log(JSON.stringify({ event: "github_release_recheck_error", channelId, repoFullName, contentId: contentId || null, flowId: flowId || null, error: String(e) }));
      return c.json({ ok: false, reason: boundedGitHubReason(e) });
    }

    const days = Number(maxWaitDays) > 0 ? Number(maxWaitDays) : 1;
    const window = buildReleaseWindow(releases!, days, includePrerelease === true, Date.now());
    const isLatest = isLatestRelease(window, publishedAt, days, Date.now());

    const props = {
      release_count_window: window.length,
      release_notes_window: JSON.stringify(window.map(({ title, content_text }) => ({ title, content_text }))),
      is_latest_release: isLatest ? 1 : 0,
    };
    console.log(JSON.stringify({ event: "github_release_recheck", channelId, repoFullName, contentId: contentId || null, flowId: flowId || null, release_count_window: props.release_count_window, is_latest_release: props.is_latest_release }));
    return c.json({ ok: true, props });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd link && npx vitest run tests/services/routes-internal-github-release-recheck.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full link suite to check for regressions**

Run: `cd link && npx vitest run`
Expected: all pass (860+ existing plus the new ones).

- [ ] **Step 6: Commit**

```bash
git add link/src/routes-internal.ts link/tests/services/routes-internal-github-release-recheck.test.ts
git commit -m "feat(link): add POST /internal/github/release-recheck"
```

---

### Task 3: Flow — `github-condition.ts`

**Files:**
- Create: `flow/src/github-condition.ts`
- Test: `flow/tests/unit/github-condition.test.ts`

**Interfaces:**
- Consumes: `conditionsPass` from `./engine` (existing, same function every condition node uses).
- Produces: `GithubReleaseCheckResponse { ok: boolean; props?: Record<string, unknown>; reason?: string }`, `GithubConditionOutcome { branch: "true"|"false"|"failed"; payload: Record<string, unknown>; failureReason?: string }`, `githubConditionRequest(args: { env: {LINK_URL: string; INTERNAL_SECRET: string}; contentId: string; flowId?: string|null; payload: Record<string, unknown>; maxWaitDays: number; includePrerelease: boolean }): {url: string; body: string}`, `resolveGithubCondition(conditions: {field:string;operator:string;value:string}[], payload: Record<string, unknown>, resp: GithubReleaseCheckResponse, logic?: unknown): GithubConditionOutcome`. Task 5 imports all four.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { githubConditionRequest, resolveGithubCondition } from "../../src/github-condition";

describe("githubConditionRequest", () => {
  it("posts the release's identity and node config to link's release-recheck route", () => {
    const req = githubConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: "f1",
      payload: { channel_id: "gh-chan", repo_full_name: "o/r", source_content_id: "123", source_created_at: "2026-08-23T00:00:00Z" },
      maxWaitDays: 7,
      includePrerelease: false,
    });
    expect(req.url).toBe("https://link/internal/github/release-recheck");
    expect(JSON.parse(req.body)).toEqual({
      channelId: "gh-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "123", publishedAt: "2026-08-23T00:00:00Z", contentId: "c1", flowId: "f1",
    });
  });

  it("sends empty strings rather than 'undefined' when the payload is missing fields", () => {
    const req = githubConditionRequest({
      env: { LINK_URL: "https://link", INTERNAL_SECRET: "s" },
      contentId: "c1",
      flowId: null,
      payload: {},
      maxWaitDays: 1,
      includePrerelease: false,
    });
    expect(JSON.parse(req.body)).toEqual({
      channelId: "", repoFullName: "", includePrerelease: false, maxWaitDays: 1,
      sourceContentId: "", publishedAt: "", contentId: "c1", flowId: null,
    });
  });
});

describe("resolveGithubCondition", () => {
  const stale = { source_content_id: "1", tag_name: "v1" };

  it("takes the true branch when every condition passes against the fresh props", () => {
    const r = resolveGithubCondition(
      [{ field: "is_latest_release", operator: "==", value: "1" }],
      stale,
      { ok: true, props: { is_latest_release: 1, release_count_window: 3 } }
    );
    expect(r.branch).toBe("true");
    expect(r.payload.release_count_window).toBe(3);
  });

  it("takes the false branch when a condition fails", () => {
    const r = resolveGithubCondition(
      [{ field: "is_latest_release", operator: "==", value: "1" }],
      stale,
      { ok: true, props: { is_latest_release: 0 } }
    );
    expect(r.branch).toBe("false");
  });

  it("takes the true branch when there are no conditions at all", () => {
    const r = resolveGithubCondition([], stale, { ok: true, props: { is_latest_release: 0 } });
    expect(r.branch).toBe("true");
  });

  it("carries link's reason on failure and leaves the payload untouched", () => {
    const r = resolveGithubCondition(
      [{ field: "is_latest_release", operator: "==", value: "1" }],
      stale,
      { ok: false, reason: "rate_limited" }
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("rate_limited");
    expect(r.payload).toEqual(stale);
  });

  it("falls back to a generic reason when the failure carries none", () => {
    const r = resolveGithubCondition([], stale, { ok: false });
    expect(r.failureReason).toBe("github_api_error: no reason reported");
  });

  it("treats an ok response with no props as a failure rather than guessing", () => {
    const r = resolveGithubCondition([], stale, { ok: true });
    expect(r.branch).toBe("failed");
  });

  it("fails rather than judging a condition field the recheck did not return", () => {
    const r = resolveGithubCondition(
      [{ field: "release_count_window", operator: ">", value: "0" }],
      { ...stale, release_count_window: 2 },
      { ok: true, props: { is_latest_release: 1 } }
    );
    expect(r.branch).toBe("failed");
    expect(r.failureReason).toBe("stat_unavailable: release_count_window not returned by GitHub");
  });

  it("does not fail on a field absent from BOTH the fresh props and the payload", () => {
    const r = resolveGithubCondition(
      [{ field: "comment_count", operator: ">", value: "1" }],
      stale,
      { ok: true, props: { is_latest_release: 1 } }
    );
    expect(r.branch).toBe("false");
    expect(r.failureReason).toBeUndefined();
  });

  it("skips half-filled rows whose field is still empty", () => {
    const r = resolveGithubCondition([{ field: "", operator: "==", value: "" }], stale, { ok: true, props: { is_latest_release: 0 } });
    expect(r.branch).toBe("true");
  });

  it("requires ALL conditions to pass by default (AND)", () => {
    const r = resolveGithubCondition(
      [
        { field: "is_latest_release", operator: "==", value: "1" },
        { field: "release_count_window", operator: ">", value: "99" },
      ],
      stale,
      { ok: true, props: { is_latest_release: 1, release_count_window: 3 } }
    );
    expect(r.branch).toBe("false");
  });

  it("logic 'or' — one pass is enough", () => {
    const r = resolveGithubCondition(
      [
        { field: "is_latest_release", operator: "==", value: "1" },
        { field: "release_count_window", operator: ">", value: "99" },
      ],
      stale,
      { ok: true, props: { is_latest_release: 1, release_count_window: 3 } },
      "or"
    );
    expect(r.branch).toBe("true");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/github-condition.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { conditionsPass } from "./engine";

export interface GithubReleaseCheckResponse {
  ok: boolean;
  props?: Record<string, unknown>;
  reason?: string;
}

export interface GithubConditionOutcome {
  branch: "true" | "false" | "failed";
  payload: Record<string, unknown>;
  failureReason?: string;
}

export function githubConditionRequest(args: {
  env: { LINK_URL: string; INTERNAL_SECRET: string };
  contentId: string;
  flowId?: string | null;
  payload: Record<string, unknown>;
  maxWaitDays: number;
  includePrerelease: boolean;
}): { url: string; body: string } {
  const { env, contentId, flowId, payload, maxWaitDays, includePrerelease } = args;
  return {
    url: `${env.LINK_URL}/internal/github/release-recheck`,
    body: JSON.stringify({
      channelId: String(payload?.channel_id ?? ""),
      repoFullName: String(payload?.repo_full_name ?? ""),
      includePrerelease,
      maxWaitDays,
      sourceContentId: String(payload?.source_content_id ?? ""),
      publishedAt: String(payload?.source_created_at ?? ""),
      contentId,
      flowId: flowId ?? null,
    }),
  };
}

// 与 resolveYouTubeCondition（youtube-condition.ts）同一套"绝不猜"守卫：条件引用的字段在
// 新鲜数据里没有、旧 payload 里却有，就升级成 failed——不能悄悄拿旧值去判一个已经不存在
// 的数。githubCondition 没有作者字段这个概念，所以这里比 youtube 版本少一层 $user.x
// 值侧引用扫描。
export function resolveGithubCondition(
  conditions: { field: string; operator: string; value: string }[],
  payload: Record<string, unknown>,
  resp: GithubReleaseCheckResponse,
  logic?: unknown
): GithubConditionOutcome {
  if (!resp.ok || !resp.props) {
    return {
      branch: "failed",
      payload,
      failureReason: resp.reason || "github_api_error: no reason reported",
    };
  }

  const merged = { ...payload, ...resp.props };
  const props = resp.props;

  for (const c of conditions || []) {
    if (!c || typeof c !== "object") continue;
    if (!c.field) continue;
    if (!(c.field in props) && c.field in payload) {
      return {
        branch: "failed",
        payload,
        failureReason: `stat_unavailable: ${c.field} not returned by GitHub`,
      };
    }
  }

  return { branch: conditionsPass(conditions, logic, merged) ? "true" : "false", payload: merged };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/github-condition.test.ts`
Expected: PASS, all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add flow/src/github-condition.ts flow/tests/unit/github-condition.test.ts
git commit -m "feat(flow): add githubConditionRequest/resolveGithubCondition"
```

---

### Task 4: Metadata — register the recheck's fresh fields

**Files:**
- Modify: `metadata/github.ts`
- Modify: `metadata/props.ts`
- Modify (tests): `link/tests/metadata/github-content-metadata.test.ts`

**Interfaces:**
- Produces: `is_latest_release`, `release_count_window`, `release_notes_window` declared (no `dataId`/`value`) on `ContentMetadata_GitHub`'s `watch:get-releases` entry, and registered in `PROPS` with `dataType` and no `entity`. Task 6's frontend Inspector reads these via the same `getContentTriggerFields(ContentMetadata_GitHub, "watch:get-releases", locale)` call the trigger's own inspector already uses.

- [ ] **Step 1: Write the failing tests**

Add to `link/tests/metadata/github-content-metadata.test.ts` (alongside the existing `release_count_1d/7d/30d` block):

```typescript
  it("githubCondition 复查值同样只声明、不给 dataId/value —— 值由 flow 侧发 recheck 之后注入", () => {
    for (const id of ["is_latest_release", "release_count_window", "release_notes_window"]) {
      const m = META.contentProps.find((p) => p.propId === id)!;
      expect(m, `prop ${id} 未声明`).toBeDefined();
      expect(m.dataId).toBeUndefined();
      expect(m.value).toBeUndefined();
    }
  });
```

Extend the existing "新增的 prop 都不带 entity" test's id list:

```typescript
    for (const id of [
      "tag_name", "is_prerelease", "release_count_1d", "release_count_7d", "release_count_30d",
      "release_notes_1d", "is_latest_release", "release_count_window", "release_notes_window",
    ]) {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd link && npx vitest run tests/metadata/github-content-metadata.test.ts`
Expected: FAIL — the three new props aren't declared/registered yet.

- [ ] **Step 3: Write the implementation**

In `metadata/github.ts`, after the `release_notes_1d` entry added in the prerequisite commit:

```typescript
      { propId: "release_notes_1d" },
      // githubCondition 节点复查后注入的新鲜值——只服务 1d 的固定窗口不一样，这三个的
      // 回看窗口是节点自己的 maxWaitDays 配置。同样只声明、不给 dataId/value。
      { propId: "is_latest_release" },
      { propId: "release_count_window" },
      { propId: "release_notes_window" },
    ],
```

In `metadata/props.ts`, after the `release_notes_1d` entry added in the prerequisite commit:

```typescript
  {
    propId: "release_notes_1d",
    dataType: "TEXT",
    label: { en: "Release Notes (24h)", zh: "24小时发版说明" },
  },
  // githubCondition 复查后的新鲜值，回看窗口是节点自己的 maxWaitDays——不是固定 24 小时。
  {
    propId: "is_latest_release",
    dataType: "ENUM_INT",
    label: { en: "Is Latest Release", zh: "是否是窗口内最新" },
    enums: [
      { value: 0, label: { en: "Not latest", zh: "不是最新" } },
      { value: 1, label: { en: "Latest", zh: "最新" } },
    ],
  },
  {
    propId: "release_count_window",
    dataType: "INT",
    label: { en: "Releases (window)", zh: "窗口内发版数" },
  },
  {
    propId: "release_notes_window",
    dataType: "TEXT",
    label: { en: "Release Notes (window)", zh: "窗口内发版说明" },
  },
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd link && npx vitest run tests/metadata/github-content-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the flow-side schema completeness check**

Run: `cd analytics && npx vitest run tests/unit/content-stream-schema.test.ts`
Expected: PASS (confirms the new entity-less props don't trip the stream-schema reconciliation check — same guard `release_count_1d` already passes).

- [ ] **Step 6: Commit**

```bash
git add metadata/github.ts metadata/props.ts link/tests/metadata/github-content-metadata.test.ts
git commit -m "feat(metadata): register githubCondition's recheck fields"
```

---

### Task 5: Flow — node type, executor, and dispatch wiring

**Files:**
- Modify: `flow/nodeTypeRegistry.ts` (add the `githubCondition` entry)
- Modify: `flow/src/node-executors.ts` (add the `githubCondition` executor case, alongside `youtubeCondition` at line 249)
- Modify: `flow/src/index.ts` (add the dispatch block in `executeContentActions`, alongside the `youtubeCondition` block at line 840; add the import at the top alongside the existing `youtube-condition` import at line 11)
- Test: `flow/tests/unit/github-condition-dispatch.test.ts` (mirrors `flow/tests/unit/youtube-condition-dispatch.test.ts`)

**Interfaces:**
- Consumes: `githubConditionRequest`, `resolveGithubCondition`, `GithubReleaseCheckResponse` (Task 3).
- Produces: the `githubCondition` node type usable in a graph; Task 6-9 (frontend) depend on `githubCondition` existing in `ReactFlowNodeType` (compile-time exhaustiveness in `nodes/index.ts` and `Inspector.tsx` forces those tasks).

- [ ] **Step 1: Write the failing test**

This mirrors `flow/tests/unit/youtube-condition-dispatch.test.ts` structure exactly (miniflare `FLOW_DB`, stubbed global `fetch` standing in for `link`, `PIPELINE_CONTENT_FLOW_LOG.send()` calls as the observable node-log stream), adapted for `githubCondition`'s trigger type, request shape, and payload fields (no author/`withAuthor` concept on this node — see Task 3):

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

const TRIGGER = { id: "t1", type: "githubContentTrigger", data: { channelId: "gh-chan", repos: [{ fullName: "o/r" }], conditions: [] }, position: { x: 0, y: 0 } };

function graphWithConditions(conditions: unknown, maxWaitDays: unknown = 7) {
  return JSON.stringify({
    nodes: [
      TRIGGER,
      { id: "gc1", type: "githubCondition", data: { conditions, maxWaitDays }, position: { x: 200, y: 0 } },
      { id: "aTrue", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
      { id: "aFalse", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
      { id: "aFailed", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 200 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "gc1" },
      { id: "e2", source: "gc1", target: "aTrue", sourceHandle: "true" },
      { id: "e3", source: "gc1", target: "aFalse", sourceHandle: "false" },
      { id: "e4", source: "gc1", target: "aFailed", sourceHandle: "failed" },
    ],
  });
}

const graphWithWaitAfterTrue = JSON.stringify({
  nodes: [
    TRIGGER,
    { id: "gc1", type: "githubCondition", data: { conditions: [{ field: "is_latest_release", operator: "==", value: "1" }], maxWaitDays: 7 }, position: { x: 200, y: 0 } },
    { id: "w1", type: "wait", data: { duration: 1, unit: "minutes" }, position: { x: 400, y: 0 } },
  ],
  edges: [
    { id: "e1", source: "t1", target: "gc1" },
    { id: "e2", source: "gc1", target: "w1", sourceHandle: "true" },
  ],
});

async function setupSchema() {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS content_flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, content_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, condition_logic TEXT NOT NULL DEFAULT ''
     )`
  ).run();
}

const FLOW_ID = "flow-gh-cond";

function makeBatch(body: Record<string, unknown>) {
  return { queue: "uniscrm-event-dev", messages: [{ body, ack: vi.fn(), retry: vi.fn() }] } as any;
}

const STALE_PAYLOAD = { channel_id: "gh-chan", repo_full_name: "o/r", source_content_id: "9", source_created_at: "2026-08-23T00:00:00Z" };

async function runCondition(
  graph: string,
  linkResponder: () => Promise<Response> | Response,
  contentId: string,
  payload: Record<string, unknown> = STALE_PAYLOAD
) {
  await setupSchema();
  await env.FLOW_DB.prepare(
    `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
     VALUES (?, 1, 'github condition flow', ?, 'published', datetime('now'), datetime('now'))`
  ).bind(FLOW_ID, graph).run();

  const fetchMock = vi.fn(async (input: any) => {
    expect(String(input)).toBe(`${(env as any).LINK_URL}/internal/github/release-recheck`);
    return await linkResponder();
  });
  vi.stubGlobal("fetch", fetchMock);

  const pipelineSend = vi.fn().mockResolvedValue(undefined);
  await worker.queue(
    makeBatch({ tenantId: "1", eventType: "content.created", contentId, channelId: "gh-chan", repoFullName: "o/r", payload }),
    { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } } as any
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [records] = pipelineSend.mock.calls[1];
  return {
    fetchMock,
    outcome: records[0].outcome as string,
    failureReason: records[0].failure_reason as string | undefined,
    reached: records.slice(1).map((r: any) => r.node_id) as string[],
  };
}

describe("executeContentActions: githubCondition dispatch", () => {
  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = ?`).bind(FLOW_ID).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = ?`).bind(FLOW_ID).run();
    vi.unstubAllGlobals();
  });

  it("sends the release's identity to link and takes the true branch when is_latest_release passes", async () => {
    const { fetchMock, outcome, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1, release_count_window: 3 } }), { status: 200 }),
      "content-gh-1"
    );
    expect(outcome).toBe("true");
    expect(reached).toEqual(["aTrue", "aTrue"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      channelId: "gh-chan", repoFullName: "o/r", sourceContentId: "9", publishedAt: "2026-08-23T00:00:00Z",
      maxWaitDays: 7, contentId: "content-gh-1", flowId: FLOW_ID,
    });
  });

  it("takes the false branch when is_latest_release is 0", async () => {
    const { outcome, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 0, release_count_window: 3 } }), { status: 200 }),
      "content-gh-2"
    );
    expect(outcome).toBe("false");
    expect(reached).toEqual(["aFalse", "aFalse"]);
  });

  it("takes the failed branch, carrying link's reason, when GitHub is rate-limited", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response(JSON.stringify({ ok: false, reason: "rate_limited" }), { status: 200 }),
      "content-gh-3"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toBe("rate_limited");
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("takes the failed branch when the fetch itself throws", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => { throw new Error("network down"); },
      "content-gh-4"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toMatch(/^github_api_error: /);
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("takes the failed branch when link returns a 5xx", async () => {
    const { outcome, failureReason, reached } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }]),
      () => new Response("upstream exploded", { status: 500 }),
      "content-gh-5"
    );
    expect(outcome).toBe("failed");
    expect(failureReason).toMatch(/^github_api_error: /);
    expect(reached).toEqual(["aFailed", "aFailed"]);
  });

  it("carries the FRESH window props into the downstream wait node", async () => {
    await setupSchema();
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES (?, 1, 'github condition wait flow', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(FLOW_ID, graphWithWaitAfterTrue).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1, release_count_window: 2, release_notes_window: "[]" } }), { status: 200 })
    ));

    await worker.queue(
      makeBatch({
        tenantId: "1", eventType: "content.created", contentId: "content-gh-6", channelId: "gh-chan", repoFullName: "o/r",
        payload: { ...STALE_PAYLOAD, existing_field: "keep-me" },
      }),
      { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: vi.fn().mockResolvedValue(undefined) } } as any
    );

    const scheduled = await env.FLOW_DB.prepare(
      `SELECT payload FROM content_flow_pending WHERE flow_id = ? AND node_id = 'w1'`
    ).bind(FLOW_ID).first<{ payload: string }>();
    expect(scheduled).toBeTruthy();

    const stored = JSON.parse(scheduled!.payload);
    expect(stored).toMatchObject({
      is_latest_release: 1, release_count_window: 2, release_notes_window: "[]",
      source_content_id: "9", existing_field: "keep-me", channel_id: "gh-chan",
    });
  });

  it("degrades to no-conditions instead of throwing when data.conditions is not an array", async () => {
    const { outcome, reached } = await runCondition(
      graphWithConditions({ field: "is_latest_release", operator: "==", value: "1" }), // object, not array
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1 } }), { status: 200 }),
      "content-gh-7"
    );
    expect(outcome).toBe("true");
    expect(reached).toEqual(["aTrue", "aTrue"]);
  });

  it("falls back to maxWaitDays: 1 when the node's config is missing/invalid", async () => {
    const { fetchMock } = await runCondition(
      graphWithConditions([{ field: "is_latest_release", operator: "==", value: "1" }], "not-a-number"),
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1 } }), { status: 200 }),
      "content-gh-8"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).maxWaitDays).toBe(1);
  });

  it("includePrerelease follows the graph's githubContentTrigger node, not a field on githubCondition itself", async () => {
    const graph = JSON.stringify({
      nodes: [
        { ...TRIGGER, data: { ...TRIGGER.data, includePrerelease: true } },
        { id: "gc1", type: "githubCondition", data: { conditions: [{ field: "is_latest_release", operator: "==", value: "1" }], maxWaitDays: 7 }, position: { x: 200, y: 0 } },
        { id: "aTrue", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 0 } },
        { id: "aFalse", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 100 } },
        { id: "aFailed", type: "action", data: { actionType: "noopLeaf" }, position: { x: 400, y: 200 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "gc1" },
        { id: "e2", source: "gc1", target: "aTrue", sourceHandle: "true" },
        { id: "e3", source: "gc1", target: "aFalse", sourceHandle: "false" },
        { id: "e4", source: "gc1", target: "aFailed", sourceHandle: "failed" },
      ],
    });
    const { fetchMock } = await runCondition(
      graph,
      () => new Response(JSON.stringify({ ok: true, props: { is_latest_release: 1 } }), { status: 200 }),
      "content-gh-9"
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).includePrerelease).toBe(true);
  });
});
```

No bespoke test needed in `flow/tests/unit/node-executors.test.ts` for the executor entry itself — that file's `describe("per-side backend maps stay exhaustive over the registry"...)` block (lines 67-96) generically asserts every `NODE_TYPE_REGISTRY` entry has a `getNodeExecutor` match and that `NODE_EXECUTORS` has no stray keys; adding the registry entry (Step 3 below) automatically brings `githubCondition` under that coverage. Run that file in Step 4 to confirm.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/github-condition-dispatch.test.ts`
Expected: FAIL — `githubCondition` isn't a recognized node type yet (TypeScript won't even compile the graph literal against `FlowNode`/`ReactFlowNodeType` until Step 3's registry entry lands — if the test file itself fails to typecheck, that also counts as "fails" for this step; proceed to Step 3 regardless).

- [ ] **Step 3: Write the implementation**

In `flow/nodeTypeRegistry.ts`, add after the `youtubeCondition` entry (after line 399):

```typescript
  githubCondition: {
    reactFlowType: "githubCondition",
    label: { en: "GitHub Release Condition", zh: "GitHub 发版条件" },
    description: { en: "Re-check current releases in a repo and branch (e.g. only the latest one wins)", zh: "重新检查repo当前发版情况并分支（例如只让最新的那条通过）" },
    domain: "content",
    role: "condition",
    generatable: true,
    sidebarSection: "flowControl",
    branches: ["true", "false", "failed"],
    propsConditions: true,
    defaultData: () => ({ conditions: [], maxWaitDays: 7 }),
    promptFragment: `githubCondition - re-fetches the current release list for the trigger's repo and branches on it, has "true"/"false"/"failed" branches
   data: { conditions: [{ field: string, operator: string, value: string }], maxWaitDays: number }
   - Requires a githubContentTrigger in the same flow. Put a wait node before it to let releases published during the wait accumulate.
   - Injects fresh release_count_window (int), release_notes_window (JSON array of {title, content_text}), is_latest_release (0/1) computed over the trailing maxWaitDays.
   - Set maxWaitDays to at least the preceding wait node's own duration. If the wait node's duration ever exceeds maxWaitDays, is_latest_release is forced to 1 regardless of whether a newer release exists (which produces extra posts) — keep wait <= maxWaitDays so this stays inert and only the recency check decides the branch.
   - "failed" means the repo/GitHub API errored — never guessed.`,
  },
```

In `flow/src/node-executors.ts`, add after the `youtubeCondition` case (after line 254):

```typescript
  githubCondition: (targetNode, ctx) => {
    // conditions/maxWaitDays 留在 graph 里（executeContentActions 用 nodeId 回查），
    // 与 youtubeCondition 把阈值留在 graph 的做法一致：改配置是纯配置变更。
    ctx.actions.push({ type: "githubCondition", nodeId: targetNode.id, hasBranches: true });
    ctx.nodeLogs.push({ nodeId: targetNode.id, direction: "exit" });
  },
```

In `flow/src/index.ts`, add the import near line 11:

```typescript
import { githubConditionRequest, resolveGithubCondition, type GithubReleaseCheckResponse } from "./github-condition";
```

Add the dispatch block in `executeContentActions`, right after the `youtubeCondition` block closes (after line 876, before `} else if (action.type === "videoAction" || ...`):

```typescript
    } else if (action.type === "githubCondition") {
      // 同步执行：GitHub /releases 是一次几百毫秒的读调用，跟 youtubeCondition 一样不进队列。
      const nodeId = action.nodeId as string;
      const conditionNode = graph.nodes.find((n) => n.id === nodeId);
      const rawConditions = conditionNode?.data?.conditions;
      const conditions = (Array.isArray(rawConditions) ? rawConditions : []) as
        { field: string; operator: string; value: string }[];
      const conditionLogic = conditionNode?.data?.conditionLogic;
      const maxWaitDays = Number(conditionNode?.data?.maxWaitDays) > 0 ? Number(conditionNode?.data?.maxWaitDays) : 1;
      // includePrerelease 跟随图里那个 githubContentTrigger 的节点配置——githubCondition
      // 自己不重复这个字段，跟 youtubeCondition 不重复 trigger 上的 duration 上限一个道理。
      const triggerNode = graph.nodes.find((n) => n.type === "githubContentTrigger");
      const includePrerelease = triggerNode?.data?.includePrerelease === true;
      const { url, body } = githubConditionRequest({ env, contentId, flowId, payload, maxWaitDays, includePrerelease });

      let resp: GithubReleaseCheckResponse;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Secret": env.INTERNAL_SECRET },
          body,
        });
        resp = res.ok
          ? (await res.json().catch(() => ({ ok: false, reason: "github_api_error: malformed response" })) as GithubReleaseCheckResponse)
          : { ok: false, reason: `github_api_error: link returned ${res.status}` };
      } catch (e) {
        resp = { ok: false, reason: `github_api_error: ${String(e)}` };
      }

      const outcome = resolveGithubCondition(conditions, payload, resp, conditionLogic);
      console.log(JSON.stringify({ event: "content_condition_github", contentId, flowId: flowId || null, nodeId, branch: outcome.branch, ok: resp.ok, logic: conditionLogic === CONDITION_LOGIC_OR ? "or" : "and", reason: outcome.failureReason || resp.reason || null }));

      await recordContentOutcome(nodeId, outcome.branch, outcome.failureReason, outcome.payload);
```

`CONDITION_LOGIC_OR` is already imported at line 9 (`from "../nodeTypeRegistry"`) and used by the `youtubeCondition` block just above — no import change needed for it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/github-condition-dispatch.test.ts tests/unit/node-executors.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full flow test suite for regressions**

Run: `cd flow && npx vitest run`
Expected: all pass (665+ existing plus the new ones). Note: `nodeTypeRegistry.ts`'s new entry makes `ReactFlowNodeType` include `"githubCondition"`, which the frontend's exhaustive `Record<ReactFlowNodeType, ...>` maps (`nodes/index.ts`, `Inspector.tsx`) do NOT yet handle — expect TypeScript compile errors in the frontend until Tasks 6-9 land. Vitest (which only typechecks the files it imports) should still pass at this point; if `npm run typecheck` is run before Task 6, it will correctly fail on those two files — that's expected, not a regression to chase down here.

- [ ] **Step 6: Commit**

```bash
git add flow/nodeTypeRegistry.ts flow/src/node-executors.ts flow/src/index.ts flow/tests/unit/github-condition-dispatch.test.ts
git commit -m "feat(flow): wire githubCondition into the node registry and dispatch pipeline"
```

---

### Task 6: Frontend — `GitHubConditionNode.tsx` canvas component

**Files:**
- Create: `flow/frontend/nodes/GitHubConditionNode.tsx`
- Modify: `flow/frontend/nodes/index.ts`

**Interfaces:**
- Consumes: `nodeLabel` (`flow/nodeTypeRegistry.ts`), `GitHubIcon` (`shared/frontend/ui/icons`), `conditionSummary` (`flow/frontend/lib/condition-logic.ts`) — same imports `YouTubeConditionNode.tsx` uses.
- Produces: `nodeTypes.githubCondition` entry consumed by React Flow's canvas.

- [ ] **Step 1: Write the component**

(No automated test — this codebase has no `.test.tsx` files; `flow/frontend/lib/*.ts` pure logic is tested at the top-level `flow/tests/unit/`, but canvas components are verified visually per Step 3 below, same as every other node component in this codebase.)

```tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import AnalyticsBadges from "./AnalyticsBadges";
import { nodeLabel } from "../../nodeTypeRegistry";
import { GitHubIcon } from "../../../shared/frontend/ui/icons";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../../shared/frontend/ui/tooltip";
import { conditionSummary } from "../lib/condition-logic";
import { useT } from "../../../shared/frontend/hooks/useT";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";

export default function GitHubConditionNode({ data, selected }: NodeProps) {
  const T = useT();
  const { locale } = useLocale();
  const conditions = (data.conditions as unknown[]) || [];
  const condCount = conditions.filter((c: any) => c?.field).length;

  return (
    <div className={`px-4 py-3 rounded-lg border-2 bg-white min-w-[170px] ${selected ? "border-blue-500 shadow-md" : "border-red-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-red-500 !w-3 !h-3" />
      <div className="flex items-center gap-2 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span><GitHubIcon className="w-4 h-4" /></span>
          </TooltipTrigger>
          <TooltipContent>GitHub</TooltipContent>
        </Tooltip>
        <span className="font-semibold text-sm text-red-700">{T(nodeLabel("githubCondition"))}</span>
      </div>
      <p className="text-xs text-gray-700">
        {condCount === 0 ? T({ en: "No conditions", zh: "无条件" }) : conditionSummary(condCount, data.conditionLogic, locale)}
      </p>
      <p className="text-xs text-gray-500">
        {T({ en: `Max wait: ${Number(data.maxWaitDays) || 7}d`, zh: `最长等待：${Number(data.maxWaitDays) || 7}天` })}
      </p>
      <AnalyticsBadges analytics={data._analytics as any} />
      <span className="absolute right-1 text-[10px] text-green-600" style={{ top: "25%", transform: "translateY(-50%)" }}>{T({ en: "True", zh: "真" })}</span>
      <span className="absolute right-1 text-[10px] text-gray-500" style={{ top: "50%", transform: "translateY(-50%)" }}>{T({ en: "False", zh: "假" })}</span>
      <span className="absolute right-1 text-[10px] text-red-500" style={{ top: "75%", transform: "translateY(-50%)" }}>{T({ en: "Failed", zh: "失败" })}</span>
      <Handle type="source" position={Position.Right} id="true" className="!bg-green-500 !w-2.5 !h-2.5" style={{ top: "25%" }} />
      <Handle type="source" position={Position.Right} id="false" className="!bg-gray-400 !w-2.5 !h-2.5" style={{ top: "50%" }} />
      <Handle type="source" position={Position.Right} id="failed" className="!bg-red-400 !w-2.5 !h-2.5" style={{ top: "75%" }} />
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `nodes/index.ts`**

```typescript
import GitHubConditionNode from "./GitHubConditionNode";
```

(add alongside the other node imports), and in the `nodeTypes` object:

```typescript
  githubCondition: GitHubConditionNode,
```

- [ ] **Step 3: Verify the frontend compiles**

Run: `cd flow && npm run typecheck` (or `npx tsc --noEmit`)
Expected: the `Record<ReactFlowNodeType, ComponentType<any>>` exhaustiveness error in `nodes/index.ts` from Task 5 is now gone. `Inspector.tsx`'s equivalent error (Task 7) is still expected at this point.

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/nodes/GitHubConditionNode.tsx flow/frontend/nodes/index.ts
git commit -m "feat(flow): add GitHubConditionNode canvas component"
```

---

### Task 7: Frontend — `GitHubConditionInspector`

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx`

**Interfaces:**
- Consumes: `getContentTriggerFields`, `ContentMetadata_GitHub` (both already imported in this file), `ConditionsEditor`, `Label`, `Input` (all already used by `WaitInspector`/`YouTubeConditionInspector` in this same file).
- Produces: `NODE_INSPECTORS.githubCondition` entry.

- [ ] **Step 1: Write the component**

Add after `YouTubeConditionInspector` (after line 1328):

```tsx
// 与 GitHubContentTriggerInspector 共用同一套字段与同一个 ConditionsEditor：判定语义必须
// 与 trigger 完全一致。maxWaitDays 单一个数字同时是"往回看多久"和"强制发帖上限"——
// 见 spec「Why one window number, not two」，两个数字会让 notes 悄悄漏内容。
function GitHubConditionInspector({ nodeId, data }: { nodeId: string; data: Record<string, any> }) {
  const T = useT();
  const { locale } = useLocale();
  const { updateNodeData } = useFlowEditor();
  const conditions = (data.conditions as Condition[]) || [];

  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{T(nodeLabel("githubCondition"))}</h4>
      <div className="space-y-3">
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Max wait (days)", zh: "最长等待（天）" })}</Label>
          <Input
            type="number"
            min="1"
            value={data.maxWaitDays || ""}
            onChange={(e: InputChange) => updateNodeData(nodeId, { maxWaitDays: parseInt(e.target.value) || 0 })}
            placeholder={T({ en: "Enter days...", zh: "输入天数…" })}
            className="w-full h-9 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {T({ en: "How far back to look for other releases, and the safety cap that force-fires past it.", zh: "往回查看其它release的窗口，也是超过后强制发帖的上限。" })}
          </p>
        </div>
        <ConditionsEditor
          conditions={conditions}
          fields={getContentTriggerFields(ContentMetadata_GitHub, "watch:get-releases", locale)}
          onChange={(c) => updateNodeData(nodeId, { conditions: c })}
          logic={data.conditionLogic}
          onLogicChange={(l) => updateNodeData(nodeId, { conditionLogic: l })}
        />
        <p className="text-xs text-muted-foreground">
          {T({ en: "Re-reads the repo's current releases from GitHub. Put a Wait node before this to let releases published during the wait accumulate.", zh: "重新从 GitHub 读取该仓库的当前发版情况。可在此节点前加一个等待节点，让等待期间新发布的release一起被算进来。" })}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `NODE_INSPECTORS`**

Add after `youtubeCondition: YouTubeConditionInspector,` (line 1745):

```typescript
  githubCondition: GitHubConditionInspector,
```

- [ ] **Step 3: Verify the frontend compiles**

Run: `cd flow && npm run typecheck`
Expected: `Inspector.tsx`'s exhaustiveness error is gone.

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/components/Inspector.tsx
git commit -m "feat(flow): add GitHubConditionInspector with maxWaitDays field"
```

---

### Task 8: Frontend — sidebar and flows-list icons

**Files:**
- Modify: `flow/frontend/components/Sidebar.tsx`
- Modify: `flow/frontend/pages/FlowsPage.tsx`

**Interfaces:**
- Consumes: `GitHubIcon` (already imported in both files, used by `githubContentTrigger`'s entries).

- [ ] **Step 1: Add the sidebar icon**

In `Sidebar.tsx`, add after `youtubeCondition: <YouTubeIcon className="w-4 h-4" />,` (line 123):

```typescript
  githubCondition: <GitHubIcon className="w-4 h-4" />,
```

- [ ] **Step 2: Add the flows-list icon**

In `FlowsPage.tsx`, add after `if (type === "youtubeCondition") return YouTubeIcon;` (line 35):

```typescript
  if (type === "githubCondition") return GitHubIcon;
```

- [ ] **Step 3: Run the dev server and visually confirm**

Run: `cd flow && npm run dev` (or the project's existing dev-server script — check `package.json`), open the editor, drag a "GitHub Release Condition" node from the sidebar's Flow Control section, confirm its icon renders (not the sidebar's fallback icon) and it appears correctly on an existing flow's card in the flows list.

- [ ] **Step 4: Commit**

```bash
git add flow/frontend/components/Sidebar.tsx flow/frontend/pages/FlowsPage.tsx
git commit -m "feat(flow): add githubCondition sidebar/flows-list icons"
```

---

### Task 9: Frontend — publish-time validation

**Files:**
- Modify: `flow/frontend/lib/validate-flow-graph.ts`
- Modify: `flow/frontend/pages/EditorPage.tsx`
- Test: `flow/tests/unit/validate-flow-graph.test.ts`

**Interfaces:**
- Consumes: `TRIGGER_NODE_TYPES`, `CONDITION_LOGIC_OR` (both already imported/exported in `validate-flow-graph.ts`).
- Produces: `findMisplacedGitHubConditionIds`, `findEmptyGitHubConditionIds` (exported functions); `validateFlowGraph`'s return object gains `misplacedGitHubConditionNodeIds: string[]` and `emptyGitHubConditionNodeIds: string[]`.

**Design note:** `validateFlowGraph`'s existing `misplacedNodeIds`/`emptyConditionNodeIds` fields are YouTube-specific in implementation despite their generic-sounding names (`findMisplacedYouTubeConditionIds`/`findEmptyYouTubeConditionIds`) — merging GitHub's results into those same arrays would make `EditorPage.tsx`'s hardcoded "YouTube Condition" error copy fire for a misconfigured `githubCondition` node. The established precedent for this exact "youtube X + github Y" shape is two separate named fields (`youtubeNoSubscriptionNodeIds` / `githubNoRepoNodeIds`, already both present) — follow that, not the misleadingly generic names.

- [ ] **Step 1: Write the failing tests**

Add to `flow/tests/unit/validate-flow-graph.test.ts`, mirroring the existing `findMisplacedYouTubeConditionIds`/`findEmptyYouTubeConditionIds` `describe` blocks exactly (read those blocks first — lines ~90-244 — and substitute `youtubeCondition`→`githubCondition`, `youtubeContentTrigger`→`githubContentTrigger`, the YouTube `ytTrigger` fixture → a `{ id: "ght", type: "githubContentTrigger" }` fixture, and `view_count`→`is_latest_release` as the example condition field):

```typescript
import { findMisplacedGitHubConditionIds, findEmptyGitHubConditionIds } from "../../frontend/lib/validate-flow-graph";

const ghTrigger = { id: "ght", type: "githubContentTrigger" };

describe("findMisplacedGitHubConditionIds", () => {
  it("flags a githubCondition whose flow is triggered by something other than GitHub", () => {
    const nodes = [
      { id: "t1", type: "xContentTrigger" },
      { id: "gc1", type: "githubCondition" },
    ];
    expect(findMisplacedGitHubConditionIds(nodes)).toEqual(["gc1"]);
  });

  it("accepts a githubCondition under a GitHub trigger", () => {
    const nodes = [
      ghTrigger,
      { id: "gc1", type: "githubCondition", data: { conditions: [{ field: "is_latest_release", operator: "==", value: "1" }] } },
    ];
    expect(findMisplacedGitHubConditionIds(nodes)).toEqual([]);
  });

  it("flags every misplaced githubCondition, not just the first", () => {
    const nodes = [
      { id: "t1", type: "xContentTrigger" },
      { id: "gc1", type: "githubCondition" },
      { id: "gc2", type: "githubCondition" },
    ];
    expect(findMisplacedGitHubConditionIds(nodes)).toEqual(["gc1", "gc2"]);
  });

  it("stays quiet about flows that contain no githubCondition", () => {
    expect(findMisplacedGitHubConditionIds([{ id: "t1", type: "xContentTrigger" }])).toEqual([]);
  });
});

describe("findEmptyGitHubConditionIds", () => {
  it("flags a githubCondition whose conditions array is empty", () => {
    const nodes = [ghTrigger, { id: "gc1", type: "githubCondition", data: { conditions: [] } }];
    expect(findEmptyGitHubConditionIds(nodes)).toEqual(["gc1"]);
  });

  it("accepts a githubCondition with one usable condition", () => {
    const nodes = [ghTrigger, { id: "gc1", type: "githubCondition", data: { conditions: [{ field: "is_latest_release", operator: "==", value: "1" }] } }];
    expect(findEmptyGitHubConditionIds(nodes)).toEqual([]);
  });

  it("ignores nodes that are not githubCondition, even with empty conditions", () => {
    const nodes = [ghTrigger, { id: "w1", type: "wait", data: { conditions: [] } }];
    expect(findEmptyGitHubConditionIds(nodes)).toEqual([]);
  });
});

describe("validateFlowGraph — githubCondition fields", () => {
  it("misplacedGitHubConditionNodeIds / emptyGitHubConditionNodeIds surface through validateFlowGraph", () => {
    const nodes = [{ id: "t1", type: "xContentTrigger" }, { id: "gc1", type: "githubCondition", data: { conditions: [] } }];
    const edges: { source: string; target: string }[] = [];
    const result = validateFlowGraph(nodes, edges);
    expect(result.misplacedGitHubConditionNodeIds).toEqual(["gc1"]);
    expect(result.emptyGitHubConditionNodeIds).toEqual(["gc1"]);
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: FAIL — `findMisplacedGitHubConditionIds`/`findEmptyGitHubConditionIds` not exported, `validateFlowGraph`'s result has no such fields.

- [ ] **Step 3: Write the implementation**

In `flow/frontend/lib/validate-flow-graph.ts`, add after `findEmptyYouTubeConditionIds` (after line 60):

```typescript
// 与 findMisplacedYouTubeConditionIds 同构：githubCondition 复查的是"触发这条流程的那个
// repo"，只在唯一 trigger 是 githubContentTrigger 的流程里有意义。
export function findMisplacedGitHubConditionIds(
  nodes: { id: string; type?: string }[]
): string[] {
  const triggers = nodes.filter((n) => TRIGGER_NODE_TYPES.includes(n.type ?? ""));
  const onlyGitHubTrigger = triggers.length === 1 && triggers[0].type === "githubContentTrigger";
  if (onlyGitHubTrigger) return [];
  return nodes.filter((n) => n.type === "githubCondition").map((n) => n.id);
}

// 与 findEmptyYouTubeConditionIds 同构：空条件的 githubCondition 恒走 true 分支
// （evaluateCondition 的 every() on [] === true），却仍然为每条内容打一次 GitHub API。
export function findEmptyGitHubConditionIds(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[]
): string[] {
  return nodes
    .filter((n) => n.type === "githubCondition")
    .filter((n) => countUsableConditions(n.data?.conditions) === 0)
    .map((n) => n.id);
}
```

Update `validateFlowGraph`'s signature and body (replace the whole function, lines 159-200):

```typescript
export function validateFlowGraph(
  nodes: { id: string; type?: string; data?: Record<string, unknown> }[],
  edges: { source: string; target: string }[]
): {
  valid: boolean;
  orphanNodeIds: string[];
  misplacedNodeIds: string[];
  emptyConditionNodeIds: string[];
  misplacedGitHubConditionNodeIds: string[];
  emptyGitHubConditionNodeIds: string[];
  orLogicEmptyNodeIds: string[];
  youtubeNoSubscriptionNodeIds: string[];
  githubNoRepoNodeIds: string[];
  xMediaConflictNodeIds: string[];
  triggerNoChannelNodeIds: string[];
} {
  const orphanNodeIds = findOrphanNodeIds(nodes, edges);
  const misplacedNodeIds = findMisplacedYouTubeConditionIds(nodes);
  const emptyConditionNodeIds = findEmptyYouTubeConditionIds(nodes);
  const misplacedGitHubConditionNodeIds = findMisplacedGitHubConditionIds(nodes);
  const emptyGitHubConditionNodeIds = findEmptyGitHubConditionIds(nodes);
  const orLogicEmptyNodeIds = findOrLogicEmptyNodeIds(nodes);
  const youtubeNoSubscriptionNodeIds = findYouTubeTriggerNoSubscriptionIds(nodes);
  const githubNoRepoNodeIds = findGitHubTriggerNoRepoIds(nodes);
  const xMediaConflictNodeIds = findXImageVideoConflictIds(nodes);
  const triggerNoChannelNodeIds = findTriggerNoChannelIds(nodes);
  return {
    valid:
      orphanNodeIds.length === 0 &&
      misplacedNodeIds.length === 0 &&
      emptyConditionNodeIds.length === 0 &&
      misplacedGitHubConditionNodeIds.length === 0 &&
      emptyGitHubConditionNodeIds.length === 0 &&
      orLogicEmptyNodeIds.length === 0 &&
      youtubeNoSubscriptionNodeIds.length === 0 &&
      githubNoRepoNodeIds.length === 0 &&
      xMediaConflictNodeIds.length === 0 &&
      triggerNoChannelNodeIds.length === 0,
    orphanNodeIds,
    misplacedNodeIds,
    emptyConditionNodeIds,
    misplacedGitHubConditionNodeIds,
    emptyGitHubConditionNodeIds,
    orLogicEmptyNodeIds,
    youtubeNoSubscriptionNodeIds,
    githubNoRepoNodeIds,
    xMediaConflictNodeIds,
    triggerNoChannelNodeIds,
  };
}
```

In `flow/frontend/pages/EditorPage.tsx`, update the destructure at line 113:

```typescript
          const { valid, orphanNodeIds, misplacedNodeIds, emptyConditionNodeIds, misplacedGitHubConditionNodeIds, emptyGitHubConditionNodeIds, orLogicEmptyNodeIds, youtubeNoSubscriptionNodeIds, githubNoRepoNodeIds, xMediaConflictNodeIds, triggerNoChannelNodeIds } =
            validateFlowGraph(nodes, edges);
```

Update the `setErrorNodeIds` spread at line 123 to include the two new arrays:

```typescript
            .setErrorNodeIds([...new Set([...orphanNodeIds, ...misplacedNodeIds, ...emptyConditionNodeIds, ...misplacedGitHubConditionNodeIds, ...emptyGitHubConditionNodeIds, ...orLogicEmptyNodeIds, ...youtubeNoSubscriptionNodeIds, ...githubNoRepoNodeIds, ...xMediaConflictNodeIds, ...triggerNoChannelNodeIds])]);
```

Add two more branches to the `title` priority chain (insert right after the existing `emptyConditionNodeIds.length > 0` branch at line 141-142, before `orLogicEmptyNodeIds`), and define the two new labels alongside `youtubeConditionLabel`/`youtubeTriggerLabel`/`githubTriggerLabel` (line 130-132):

```typescript
            const youtubeConditionLabel = T(nodeLabel("youtubeCondition"));
            const youtubeTriggerLabel = T(nodeLabel("youtubeContentTrigger"));
            const githubTriggerLabel = T(nodeLabel("githubContentTrigger"));
            const githubConditionLabel = T(nodeLabel("githubCondition"));
            const title =
              orphanNodeIds.length > 0
                ? T({ en: `${orphanNodeIds.length} node(s) not connected, cannot publish`, zh: `${orphanNodeIds.length} 个节点未连接，无法发布` })
                : triggerNoChannelNodeIds.length > 0
                  ? T({
                      en: "The trigger has no account selected, so this flow would never fire. Pick one in the trigger node.",
                      zh: "触发器没有选择账号，这个流程永远不会触发。请在 trigger 节点里选一个账号。",
                    })
                  : emptyConditionNodeIds.length > 0
                    ? T({ en: `${youtubeConditionLabel} has no conditions set, cannot publish`, zh: `${youtubeConditionLabel} 没有设置条件，无法发布` })
                    : emptyGitHubConditionNodeIds.length > 0
                      ? T({ en: `${githubConditionLabel} has no conditions set, cannot publish`, zh: `${githubConditionLabel} 没有设置条件，无法发布` })
                      : orLogicEmptyNodeIds.length > 0
                        ? T({ en: `${orLogicEmptyNodeIds.length} node(s) selected OR but have no conditions, cannot publish`, zh: `${orLogicEmptyNodeIds.length} 个节点选了 OR 但没有条件，无法发布` })
                        : youtubeNoSubscriptionNodeIds.length > 0
                          ? T({ en: `${youtubeNoSubscriptionNodeIds.length} ${youtubeTriggerLabel}(s) have no subscription selected, cannot publish`, zh: `${youtubeNoSubscriptionNodeIds.length} 个 ${youtubeTriggerLabel} 没有选择 subscription，无法发布` })
                          : githubNoRepoNodeIds.length > 0
                            ? T({ en: `${githubNoRepoNodeIds.length} ${githubTriggerLabel}(s) have no repository selected, cannot publish`, zh: `${githubNoRepoNodeIds.length} 个 ${githubTriggerLabel} 没有选择仓库，无法发布` })
                            : xMediaConflictNodeIds.length > 0
                              ? T({
                                  en: `${xMediaConflictNodeIds.length} X Content Action(s) can only attach either an image or a video, not both, cannot publish`,
                                  zh: `${xMediaConflictNodeIds.length} 个 X Content Action 只能附加图片或视频之一，不能同时勾选，无法发布`,
                                })
                              : misplacedGitHubConditionNodeIds.length > 0
                                ? T({ en: `${githubConditionLabel} can only be used in a flow whose sole trigger is ${githubTriggerLabel}, cannot publish`, zh: `${githubConditionLabel} 只能用在唯一 trigger 是 ${githubTriggerLabel} 的流程里，无法发布` })
                                : T({ en: `${youtubeConditionLabel} can only be used in a flow whose sole trigger is ${youtubeTriggerLabel}, cannot publish`, zh: `${youtubeConditionLabel} 只能用在唯一 trigger 是 ${youtubeTriggerLabel} 的流程里，无法发布` });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd flow && npx vitest run tests/unit/validate-flow-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full flow test suite and typecheck**

Run: `cd flow && npx vitest run && npm run typecheck`
Expected: both clean — this closes out every exhaustiveness/compile gap `githubCondition` opened across Tasks 5-9.

- [ ] **Step 6: Deploy to dev and self-test**

Run: `cd flow && npm run deploy:dev` and `cd link && npm run deploy:dev` (both modules changed). In the browser (flow-dev editor), build a small graph: `githubContentTrigger` → `wait` → `githubCondition` (set `maxWaitDays`) → an action node, confirm: publish succeeds with a valid condition set, publish is blocked with the correct GitHub-specific message when conditions are empty or the node sits under a non-GitHub trigger, and the node's sidebar/canvas/inspector all render correctly.

- [ ] **Step 7: Commit**

```bash
git add flow/frontend/lib/validate-flow-graph.ts flow/frontend/pages/EditorPage.tsx flow/tests/unit/validate-flow-graph.test.ts
git commit -m "feat(flow): publish-time validation for githubCondition placement and empty conditions"
```

---

## Follow-up (explicitly out of scope for this plan — see spec Non-Goals)

- Editing the `479e207c` flow's own graph (removing `release_count_1d == 1`, wiring in `githubContentTrigger → wait → githubCondition → xContentAction`) is a UI change the user makes to their own flow once this ships.
- Authoring the events-classification skill (hosting/sponsoring/speaking/attending) that reads `release_notes_window` is a separate, content-side task (tenant-uploaded `SKILL.md`), unrelated to this plan's code.

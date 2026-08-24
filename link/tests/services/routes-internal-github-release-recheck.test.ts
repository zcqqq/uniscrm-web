/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

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

beforeAll(async () => {
  // vitest-pool-workers doesn't auto-apply migrations/ -- create the table by hand, matching
  // the established pattern in routes-internal-channels-summary.test.ts.
  await env.LINK_DB.prepare(
    `CREATE TABLE IF NOT EXISTS channels (
       id TEXT PRIMARY KEY,
       channel_type TEXT NOT NULL,
       config TEXT NOT NULL DEFAULT '{}',
       tenant_id INTEGER,
       is_active INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
});

beforeEach(async () => {
  listReleasesMock.mockReset();
  await env.LINK_DB.prepare(
    `INSERT INTO channels (id, tenant_id, channel_type, config, is_active)
     VALUES ('gh-chan', 1, 'GITHUB', ?, 1)
     ON CONFLICT(id) DO UPDATE SET config = excluded.config`
  ).bind(JSON.stringify({ access_token: "tok" })).run();
});

async function recheck(body: Record<string, unknown>) {
  const res = await worker.fetch(
    new Request("https://link-dev.uni-scrm.com/internal/github/release-recheck", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Secret": "dev-internal-secret" },
      body: JSON.stringify(body),
    }),
    env
  );
  return res;
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
    const body = (await res.json()) as {
      ok: boolean;
      props: { release_count_window: number; release_notes_window: string; is_latest_release: number };
    };
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

    const body = (await res.json()) as { props: { is_latest_release: number } };
    expect(body.props.is_latest_release).toBe(0);
  });

  it("限流 → ok:false, reason: rate_limited", async () => {
    listReleasesMock.mockResolvedValue({ releases: null, etag: null, rateLimited: true, notFound: false });
    const res = await recheck({
      channelId: "gh-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "1", publishedAt: new Date().toISOString(), contentId: "c1", flowId: "f1",
    });
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("rate_limited");
  });

  it("repo 读不到 → ok:false, reason: repo_unavailable", async () => {
    listReleasesMock.mockResolvedValue({ releases: null, etag: null, rateLimited: false, notFound: true });
    const res = await recheck({
      channelId: "gh-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "1", publishedAt: new Date().toISOString(), contentId: "c1", flowId: "f1",
    });
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("repo_unavailable");
  });

  it("channel 没有 GitHub token → ok:false", async () => {
    const res = await recheck({
      channelId: "no-such-chan", repoFullName: "o/r", includePrerelease: false, maxWaitDays: 7,
      sourceContentId: "1", publishedAt: new Date().toISOString(), contentId: "c1", flowId: "f1",
    });
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

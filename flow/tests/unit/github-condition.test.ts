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

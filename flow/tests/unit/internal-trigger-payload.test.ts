import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// POST /internal/trigger is the fourth (and, until this test existed, the last unconverted)
// consumer of ExecutionResult.payload. executeFlow evaluates the trigger's conditions against
// the ENRICHED payload — for githubContentTrigger that is the only place release_count_1d/7d/30d
// exist, and it is also where release_history is stripped. Handing the raw request payload to
// executeActions instead means:
//   - $event.release_count_7d in an action interpolates to "" (the ?? "" fallback), so a flow
//     tested through this endpoint behaves differently from the same flow in production;
//   - release_history (up to 100 entries) leaks whole into the action body.
// The two assertions below fail if the call site is reverted to `payload` (verified by mutation).
//
// This endpoint is the reason the is_prerelease normalization cannot be trusted downstream
// either: it accepts an arbitrary payload, so the matcher must coerce rather than compare
// strictly (node-executors.ts) — pinned in node-executors.test.ts, not here.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// includePrerelease defaults to false on the node, so the 3-day-old prerelease is excluded:
// 1d = 1, 7d = 1, 30d = 2.
function releaseHistory() {
  return [
    { published_at: new Date(Date.now() - 2 * HOUR).toISOString(), prerelease: false, title: "v1.4.0", content_text: "dark mode" },
    { published_at: new Date(Date.now() - 3 * DAY).toISOString(), prerelease: true },
    { published_at: new Date(Date.now() - 10 * DAY).toISOString(), prerelease: false },
  ];
}

const graphJson = JSON.stringify({
  nodes: [
    { id: "t1", type: "githubContentTrigger", data: { channelId: "gh-chan", repos: [{ fullName: "oven-sh/bun" }], conditions: [] }, position: { x: 0, y: 0 } },
    // webhook is the one action type whose body is fully observable from a fetch spy and
    // interpolates straight out of the payload — the cheapest possible probe of what
    // executeActions was handed.
    { id: "a1", type: "webhook", data: { url: "https://hook.test/x", method: "POST", body: "count7=$event.release_count_7d" }, position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
});

beforeAll(async () => {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY,
       tenant_id INTEGER NOT NULL,
       member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow',
       description TEXT DEFAULT '',
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
       status TEXT NOT NULL DEFAULT 'draft',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       domain TEXT NOT NULL DEFAULT 'user',
       trigger_count INTEGER
     )`
  ).run();
});

describe("POST /internal/trigger runs actions against the trigger-enriched payload", () => {
  beforeEach(async () => {
    await env.FLOW_DB.prepare(
      `INSERT INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES ('flow-trigger-gh', 4242, 'gh release', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(graphJson).run();
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = 'flow-trigger-gh'`).run();
    vi.unstubAllGlobals();
  });

  async function trigger(payload: Record<string, unknown>) {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      new Request("https://flow.test/internal/trigger", {
        method: "POST",
        headers: { "X-Internal-Secret": (env as any).INTERNAL_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: 4242, eventType: "content.created", userId: "u1", payload }),
      }),
      env
    );
    return { res, fetchMock };
  }

  it("interpolates the release counts the trigger computed, not an empty string", async () => {
    const { res, fetchMock } = await trigger({
      channel_id: "gh-chan", repo_full_name: "oven-sh/bun", is_prerelease: 0,
      tag_name: "v1.2.3", release_history: releaseHistory(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ triggered: 1 });

    const call = fetchMock.mock.calls.find(([u]) => String(u) === "https://hook.test/x");
    expect(call, "expected the webhook action to fire").toBeDefined();
    // With the raw payload this is "count7=" — release_count_7d does not exist on it.
    expect((call![1] as RequestInit).body).toBe("count7=1");
  });

  it("does not leak release_history into the action payload", async () => {
    // No `body` on the action -> executeActions serializes { userId, ...payload }, which makes
    // every key the action was handed directly observable.
    await env.FLOW_DB.prepare(`UPDATE flows SET graph_json = ? WHERE id = 'flow-trigger-gh'`)
      .bind(graphJson.replace(',"body":"count7=$event.release_count_7d"', ""))
      .run();

    const { fetchMock } = await trigger({
      channel_id: "gh-chan", repo_full_name: "oven-sh/bun", is_prerelease: 0,
      release_history: releaseHistory(),
    });

    const call = fetchMock.mock.calls.find(([u]) => String(u) === "https://hook.test/x");
    expect(call, "expected the webhook action to fire").toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.release_history).toBeUndefined();
    expect(body.release_count_30d).toBe(2);
  });

  it("release_notes_1d reaches the action payload as the JSON array the trigger computed", async () => {
    await env.FLOW_DB.prepare(`UPDATE flows SET graph_json = ? WHERE id = 'flow-trigger-gh'`)
      .bind(graphJson.replace(',"body":"count7=$event.release_count_7d"', ""))
      .run();

    const { fetchMock } = await trigger({
      channel_id: "gh-chan", repo_full_name: "oven-sh/bun", is_prerelease: 0,
      release_history: releaseHistory(),
    });

    const call = fetchMock.mock.calls.find(([u]) => String(u) === "https://hook.test/x");
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.release_notes_1d).toBe(JSON.stringify([{ title: "v1.4.0", content_text: "dark mode" }]));
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker, { shouldRecomputeCounts } from "../../src/index";

// The counts reconcile is the single biggest D1 write source flow had: rebuilding both count
// tables on every one-minute tick cost ~577k rows written/day on dev (5.8× the free plan's whole
// daily allowance), which is why the account started rejecting writes. It now runs on the top of
// the hour only, while the pending sweeps keep their every-minute cadence — these tests pin both
// halves of that split so a future "just move it back next to the sweep" refactor fails loudly.
async function setupSchema() {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT NULL,
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
       trigger_count INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flow_counts (
       tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
       count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS content_flow_counts (
       tenant_id INTEGER NOT NULL, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, direction TEXT NOT NULL,
       count INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (flow_id, node_id, direction)
     )`
  ).run();
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flow_pending (
       id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, node_id TEXT NOT NULL, user_id TEXT NOT NULL,
       tenant_id INTEGER NOT NULL, payload TEXT NOT NULL, execute_at TEXT NOT NULL,
       awaiting_event TEXT NOT NULL DEFAULT '', conditions TEXT NOT NULL DEFAULT '',
       retry_action TEXT NOT NULL DEFAULT '', retry_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, condition_logic TEXT NOT NULL DEFAULT ''
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

describe("shouldRecomputeCounts", () => {
  it("runs on the top of the hour", () => {
    expect(shouldRecomputeCounts({ scheduledTime: Date.UTC(2026, 10, 12, 10, 0) })).toBe(true);
  });

  it("skips the other 59 ticks", () => {
    for (const minute of [1, 5, 30, 59]) {
      expect(shouldRecomputeCounts({ scheduledTime: Date.UTC(2026, 10, 12, 10, minute) })).toBe(false);
    }
  });

  it("keeps the historic every-tick behaviour when the trigger time is unknown", () => {
    // Tests (and any older runtime) drive scheduled() with a bare controller — never silently
    // stop recomputing there, or the counts would freeze forever with no signal.
    expect(shouldRecomputeCounts({})).toBe(true);
    expect(shouldRecomputeCounts({ scheduledTime: undefined })).toBe(true);
  });
});

describe("scheduled(): counts reconcile cadence", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await setupSchema();
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, result: { rows: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows`).run();
    await env.FLOW_DB.prepare(`DELETE FROM flow_counts`).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_counts`).run();
    vi.unstubAllGlobals();
  });

  it("does not touch R2 on a non-hourly tick", async () => {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 12, 10, 5) } as any, env);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reconciles counts on an hourly tick", async () => {
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 12, 10, 0) } as any, env);

    const queries = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body).query as string);
    expect(queries.some((q) => q.includes("FROM uniscrm.flow_log"))).toBe(true);
    expect(queries.some((q) => q.includes("FROM uniscrm.content_flow_log"))).toBe(true);
  });
});

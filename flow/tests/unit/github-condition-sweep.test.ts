import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";

// 这个文件补的是 github-condition-dispatch.test.ts 覆盖不到的那一段：那边是
// trigger → githubCondition 直连，复查在 worker.queue() 的同一次调用里同步发生。真实的、
// 也是这个特性唯一有意义的拓扑是 trigger → wait → githubCondition → action，只能这样走到：
// release 触发后进 wait 节点，写一行 content_flow_pending；execute_at 过期后由
// worker.scheduled() 的 content sweep 扫出来，githubCondition 是在那里才被 dispatch 的。
//
// 更重要的是，这里证明的是这个特性的核心承诺本身——「窗口内 N 条 release → 下游恰好执行
// 1 次」。逐跳的单元测试各自都绿，并不能推出这一条；只有把两条独立的链一起跑完、数出口
// 才算数。
const FLOW_ID = "flow-gh-sweep";

const graph = JSON.stringify({
  nodes: [
    { id: "ght", type: "githubContentTrigger", data: { channelId: "gh-chan", repos: [{ fullName: "o/r" }], conditions: [] }, position: { x: 0, y: 0 } },
    { id: "w1", type: "wait", data: { duration: 1, unit: "days" }, position: { x: 200, y: 0 } },
    { id: "gc1", type: "githubCondition", data: { conditions: [{ field: "is_latest_release", operator: "==", value: "1" }], maxWaitDays: 7 }, position: { x: 400, y: 0 } },
    { id: "aTrue", type: "action", data: { actionType: "noopLeaf" }, position: { x: 600, y: 0 } },
    { id: "aFalse", type: "action", data: { actionType: "noopLeaf" }, position: { x: 600, y: 100 } },
  ],
  edges: [
    { id: "e1", source: "ght", target: "w1" },
    { id: "e2", source: "w1", target: "gc1" },
    { id: "e3", source: "gc1", target: "aTrue", sourceHandle: "true" },
    { id: "e4", source: "gc1", target: "aFalse", sourceHandle: "false" },
  ],
});

// A 早、B 晚，同一个 repo。id 与发布时间同向递增，和 GitHub 自增 id 的真实语义一致。
const RELEASE_A = { channel_id: "gh-chan", repo_full_name: "o/r", source_content_id: "10", source_created_at: "2026-08-23T00:00:00Z" };
const RELEASE_B = { channel_id: "gh-chan", repo_full_name: "o/r", source_content_id: "20", source_created_at: "2026-08-23T06:00:00Z" };

async function setupSchema() {
  await env.FLOW_DB.prepare(
    `CREATE TABLE IF NOT EXISTS flows (
       id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, member_id TEXT NOT NULL DEFAULT '',
       name TEXT NOT NULL DEFAULT 'Untitled Flow', description TEXT DEFAULT '',
       graph_json TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', status TEXT NOT NULL DEFAULT 'draft',
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL
     )`
  ).run();
  // scheduled() 无条件先查 flow_pending，表不存在会在 content sweep 之前就抛错。
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

describe("scheduled(): wait → githubCondition, N releases in a window → exactly 1 execution", () => {
  beforeEach(setupSchema);

  afterEach(async () => {
    await env.FLOW_DB.prepare(`DELETE FROM flows WHERE id = ?`).bind(FLOW_ID).run();
    await env.FLOW_DB.prepare(`DELETE FROM content_flow_pending WHERE flow_id = ?`).bind(FLOW_ID).run();
    vi.unstubAllGlobals();
  });

  it("two releases' chains both resume, only the later one's reaches the action", async () => {
    await env.FLOW_DB.prepare(
      `INSERT OR REPLACE INTO flows (id, tenant_id, name, graph_json, status, created_at, updated_at)
       VALUES (?, 1, 'github release digest', ?, 'published', datetime('now'), datetime('now'))`
    ).bind(FLOW_ID, graph).run();

    // 两条 release 各自的 wait 都已到期——这正是"同一个窗口里的 N 条 release"在
    // content_flow_pending 里的样子：每条一行，彼此完全不知道对方存在。
    const past = new Date(Date.now() - 1000).toISOString();
    for (const [id, contentId, payload] of [
      ["pend-a", "content-A", RELEASE_A],
      ["pend-b", "content-B", RELEASE_B],
    ] as const) {
      await env.FLOW_DB.prepare(
        `INSERT INTO content_flow_pending (id, flow_id, node_id, content_id, tenant_id, payload, execute_at, created_at)
         VALUES (?, ?, 'w1', ?, 1, ?, ?, datetime('now'))`
      ).bind(id, FLOW_ID, contentId, JSON.stringify(payload), past).run();
    }

    // 站在 link 的位置回答：B 更晚，所以只有 B 是窗口里最新的那条。两条链都看到同一个
    // 两条 release 的窗口（release_count_window: 2），区别只在 is_latest_release。
    // scheduled() 还会顺带跑 flow counts 的重算（打 R2 SQL），与本用例无关：只拦
    // release-recheck，其它 URL 一律回一个无害的空响应。
    const RECHECK_URL = `${(env as Record<string, unknown>).LINK_URL}/internal/github/release-recheck`;
    const recheckCalls: { sourceContentId: string }[] = [];
    const fetchMock = vi.fn(async (input: unknown, init: { body: string }) => {
      if (String(input) !== RECHECK_URL) return new Response("{}", { status: 200 });
      const body = JSON.parse(init.body) as { sourceContentId: string };
      recheckCalls.push(body);
      return new Response(
        JSON.stringify({
          ok: true,
          props: {
            is_latest_release: body.sourceContentId === RELEASE_B.source_content_id ? 1 : 0,
            release_count_window: 2,
            release_notes_window: JSON.stringify([{ title: "v1", content_text: "a" }, { title: "v2", content_text: "b" }]),
          },
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const pipelineSend = vi.fn().mockResolvedValue(undefined);
    await worker.scheduled({} as never, { ...env, PIPELINE_CONTENT_FLOW_LOG: { send: pipelineSend } } as never);

    // 两条链都真的复查过——否则"只有一条通过"可能只是因为另一条压根没跑。
    expect(recheckCalls.map((b) => b.sourceContentId).sort()).toEqual(["10", "20"]);

    // 两行 pending 都被 claim 掉，没有残留。
    const remaining = await env.FLOW_DB.prepare(
      `SELECT COUNT(*) AS n FROM content_flow_pending WHERE flow_id = ?`
    ).bind(FLOW_ID).first<{ n: number }>();
    expect(remaining!.n).toBe(0);

    // 核心断言：跨两次 sweep 展平后数出口，action 节点恰好进入 1 次。
    const all = pipelineSend.mock.calls.flatMap(([records]) => records as { node_id: string; direction: string; content_id: string }[]);
    const fired = all.filter((r) => r.node_id === "aTrue" && r.direction === "enter");
    expect(fired).toHaveLength(1);
    expect(fired[0].content_id).toBe("content-B");

    // 而 A 那条链没有静默消失——它明确走了 false 分支，画布上数得出来。
    const dropped = all.filter((r) => r.node_id === "aFalse" && r.direction === "enter");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].content_id).toBe("content-A");
  });
});

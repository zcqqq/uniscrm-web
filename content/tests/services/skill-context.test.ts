/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { getSkillContext, getSkillContextRow, setSkillContext } from "../../src/services/skill-context";

const REPO = "coreyhaines31/marketingskills";

beforeAll(async () => {
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS skill_context (
       tenant_id INTEGER NOT NULL, skill_repo TEXT NOT NULL, content TEXT NOT NULL,
       version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, skill_repo))`
  ).run();
});

describe("skill context", () => {
  it("没写过就是 null —— 没有任何功能以它的存在为前提", async () => {
    expect(await getSkillContext(env as never, 7001, REPO)).toBeNull();
    expect(await getSkillContextRow(env as never, 7001, REPO)).toBeNull();
  });

  it("首次保存为 v1", async () => {
    const { version } = await setSkillContext(env as never, 7002, REPO, "# ctx v1");
    expect(version).toBe(1);
    expect(await getSkillContext(env as never, 7002, REPO)).toBe("# ctx v1");
  });

  it("再次保存递增版本并覆盖正文", async () => {
    await setSkillContext(env as never, 7003, REPO, "# first");
    const { version } = await setSkillContext(env as never, 7003, REPO, "# second");
    expect(version).toBe(2);
    const row = await getSkillContextRow(env as never, 7003, REPO);
    expect(row).toEqual(expect.objectContaining({ content: "# second", version: 2 }));
  });

  // 多租户隔离：一个租户的定位文档串到另一个租户，会污染对方此后所有生成。
  it("按 (tenant_id, skill_repo) 隔离", async () => {
    await setSkillContext(env as never, 7004, REPO, "# tenant A");
    await setSkillContext(env as never, 7005, REPO, "# tenant B");
    await setSkillContext(env as never, 7004, "someone/otherpack", "# other pack");
    expect(await getSkillContext(env as never, 7004, REPO)).toBe("# tenant A");
    expect(await getSkillContext(env as never, 7005, REPO)).toBe("# tenant B");
    expect(await getSkillContext(env as never, 7004, "someone/otherpack")).toBe("# other pack");
  });
});

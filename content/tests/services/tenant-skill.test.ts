/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  UPLOAD_PREFIX, slugifySkillName, listTenantSkills, getTenantSkillContent,
  upsertTenantSkill, deleteTenantSkill, findExistingSkillIds,
} from "../../src/services/tenant-skill";

beforeAll(async () => {
  await env.CONTENT_DB.prepare(
    `CREATE TABLE IF NOT EXISTS tenant_skill (
       tenant_id INTEGER NOT NULL, skill_id TEXT NOT NULL, label TEXT NOT NULL,
       content TEXT NOT NULL, source TEXT NOT NULL, uploaded_at TEXT NOT NULL,
       PRIMARY KEY (tenant_id, skill_id))`
  ).run();
});

describe("slugifySkillName", () => {
  it("小写化并把非字母数字压成单个连字符", () => {
    expect(slugifySkillName("Social Media")).toBe("social-media");
    expect(slugifySkillName("公司内部/文案 规范")).toBe("公司内部-文案-规范");
    expect(slugifySkillName("  a__b  ")).toBe("a-b");
  });
});

describe("tenant skill 存取", () => {
  it("没写过就是 null / 空列表", async () => {
    expect(await getTenantSkillContent(env as never, 8101, "upload:x")).toBeNull();
    expect(await listTenantSkills(env as never, 8101)).toEqual([]);
  });

  it("写入后可读回，列表带上元信息与字节数", async () => {
    await upsertTenantSkill(env as never, 8102, {
      skillId: `${UPLOAD_PREFIX}social`, label: "Social", content: "# hi", source: "social.zip",
    });
    expect(await getTenantSkillContent(env as never, 8102, `${UPLOAD_PREFIX}social`)).toBe("# hi");
    const list = await listTenantSkills(env as never, 8102);
    expect(list).toEqual([
      expect.objectContaining({ skillId: `${UPLOAD_PREFIX}social`, label: "Social", source: "social.zip", bytes: 4 }),
    ]);
  });

  it("同 id 重写覆盖，不新增行", async () => {
    await upsertTenantSkill(env as never, 8103, { skillId: `${UPLOAD_PREFIX}a`, label: "A", content: "v1", source: "a.md" });
    await upsertTenantSkill(env as never, 8103, { skillId: `${UPLOAD_PREFIX}a`, label: "A", content: "v2", source: "a2.md" });
    expect(await getTenantSkillContent(env as never, 8103, `${UPLOAD_PREFIX}a`)).toBe("v2");
    expect(await listTenantSkills(env as never, 8103)).toHaveLength(1);
  });

  // 隔离是这张表存在的全部理由：一个租户读到另一个租户上传的正文，就等于把私有资料喂进了对方的提示词。
  it("按 tenant_id 隔离：读、列、删都不越界", async () => {
    await upsertTenantSkill(env as never, 8104, { skillId: `${UPLOAD_PREFIX}s`, label: "S", content: "A 的", source: "a.md" });
    await upsertTenantSkill(env as never, 8105, { skillId: `${UPLOAD_PREFIX}s`, label: "S", content: "B 的", source: "b.md" });

    expect(await getTenantSkillContent(env as never, 8104, `${UPLOAD_PREFIX}s`)).toBe("A 的");
    expect(await getTenantSkillContent(env as never, 8105, `${UPLOAD_PREFIX}s`)).toBe("B 的");

    await deleteTenantSkill(env as never, 8104, `${UPLOAD_PREFIX}s`);
    expect(await getTenantSkillContent(env as never, 8104, `${UPLOAD_PREFIX}s`)).toBeNull();
    expect(await getTenantSkillContent(env as never, 8105, `${UPLOAD_PREFIX}s`)).toBe("B 的");
  });

  it("findExistingSkillIds 只回本租户已存在的那些", async () => {
    await upsertTenantSkill(env as never, 8106, { skillId: `${UPLOAD_PREFIX}p`, label: "P", content: "x", source: "p.md" });
    await upsertTenantSkill(env as never, 8107, { skillId: `${UPLOAD_PREFIX}q`, label: "Q", content: "x", source: "q.md" });
    expect(await findExistingSkillIds(env as never, 8106, [`${UPLOAD_PREFIX}p`, `${UPLOAD_PREFIX}q`]))
      .toEqual([`${UPLOAD_PREFIX}p`]);
  });

  it("findExistingSkillIds 传空数组时不查库也不报错", async () => {
    expect(await findExistingSkillIds(env as never, 8106, [])).toEqual([]);
  });
});

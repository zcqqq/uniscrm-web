import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseSkillFiles, unzipToEntries } from "../frontend/lib/skill-package";

const md = (name: string) => `---\nname: ${name}\n---\n\n# ${name}`;

describe("parseSkillFiles — 单技能", () => {
  it("根目录有 SKILL.md 就是单技能，名字取 frontmatter 的 name", () => {
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("social") },
      { path: "references/limits.md", text: "280" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("social");
    expect(out[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/limits.md"]);
  });

  it("frontmatter 没有 name 时退回目录名", () => {
    const out = parseSkillFiles([{ path: "my-skill/SKILL.md", text: "# 无 frontmatter" }]);
    expect(out[0].name).toBe("my-skill");
  });

  it("单个 .md 文件视作只有 SKILL.md 的技能，名字取文件名", () => {
    const out = parseSkillFiles([{ path: "内部文案规范.md", text: "# 规范" }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("内部文案规范");
    expect(out[0].files).toEqual([{ path: "SKILL.md", content: "# 规范" }]);
  });
});

describe("parseSkillFiles — 整包", () => {
  it("每个含 SKILL.md 的子目录各成一个技能，路径按技能目录归一化", () => {
    const out = parseSkillFiles([
      { path: "skills/social/SKILL.md", text: md("social") },
      { path: "skills/social/references/a.md", text: "A" },
      { path: "skills/image/SKILL.md", text: md("image") },
    ]);
    expect(out.map((s) => s.name).sort()).toEqual(["image", "social"]);
    const social = out.find((s) => s.name === "social")!;
    // 归一化很关键：inlineReferencesFromFiles 按 SKILL.md 里的 "references/a.md" 原样查表
    expect(social.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/a.md"]);
  });
});

describe("parseSkillFiles — 过滤与上限", () => {
  it("丢弃非 .md 与 evals/", () => {
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("s") },
      { path: "references/a.md", text: "A" },
      { path: "evals/case1.md", text: "E" },
      { path: "logo.png", text: "binary" },
      { path: "run.sh", text: "#!/bin/sh" },
    ]);
    expect(out[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("references 超过 8 个时只取前 8", () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ path: `references/r${i}.md`, text: `${i}` }));
    const out = parseSkillFiles([{ path: "SKILL.md", text: md("s") }, ...refs]);
    expect(out[0].files.filter((f) => f.path.startsWith("references/"))).toHaveLength(8);
  });

  it("既没有根 SKILL.md 也没有含 SKILL.md 的子目录 → 抛错", () => {
    expect(() => parseSkillFiles([{ path: "readme.md", text: "x" }, { path: "a/b.md", text: "y" }]))
      .toThrow(/SKILL\.md/);
  });

  it("空清单 → 抛错", () => {
    expect(() => parseSkillFiles([])).toThrow(/SKILL\.md/);
  });
});

describe("unzipToEntries", () => {
  it("解出 zip 里的文本文件，忽略目录条目", () => {
    const zip = zipSync({
      "social/SKILL.md": strToU8(md("social")),
      "social/references/a.md": strToU8("A"),
    });
    const entries = unzipToEntries(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(["social/SKILL.md", "social/references/a.md"]);
    expect(entries.find((e) => e.path.endsWith("a.md"))!.text).toBe("A");
  });

  it("解出来的清单能直接喂给 parseSkillFiles", () => {
    const zip = zipSync({ "SKILL.md": strToU8(md("z")), "references/r.md": strToU8("R") });
    const out = parseSkillFiles(unzipToEntries(zip));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("z");
  });
});

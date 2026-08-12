import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseSkillFiles, unzipToEntries } from "../frontend/lib/skill-package";

// refs 是要在正文里内联的 markdown 链接（服务端 REFERENCE_LINK_RE 靠这个识别，不是靠文件是否
// 上传了），不传就是没有任何 references 链接的最简 SKILL.md。
const md = (name: string, refs: string[] = []) =>
  `---\nname: ${name}\n---\n\n# ${name}\n\n${refs.map((r) => `[${r}](${r})`).join("\n")}`;

describe("parseSkillFiles — 单技能", () => {
  it("根目录有 SKILL.md 就是单技能，名字取 frontmatter 的 name", () => {
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("social", ["references/limits.md"]) },
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
      { path: "skills/social/SKILL.md", text: md("social", ["references/a.md"]) },
      { path: "skills/social/references/a.md", text: "A" },
      { path: "skills/image/SKILL.md", text: md("image") },
    ]);
    expect(out.map((s) => s.name).sort()).toEqual(["image", "social"]);
    const social = out.find((s) => s.name === "social")!;
    // 归一化很关键：inlineReferencesFromFiles 按 SKILL.md 里的 "references/a.md" 原样查表
    expect(social.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("根目录有 SKILL.md 时，即便子目录也有 SKILL.md，整包只算一个技能（根目录优先）", () => {
    // 回归用例：曾经不分根/子目录一律"每个 SKILL.md 各成一个技能"，导致这种上传结构被拆成 3 个。
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("root") },
      { path: "skills/social/SKILL.md", text: md("social") },
      { path: "skills/image/SKILL.md", text: md("image") },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("root");
  });
});

describe("parseSkillFiles — references 按链接选取，不是按文件顺序", () => {
  it("SKILL.md 没链接到的 references 文件即使先出现也不会被选中（服务端只按链接内联）", () => {
    // 回归用例：曾经按 entries 数组顺序取前 8 个 references/*.md，与服务端按 SKILL.md 里
    // 链接顺序选取的规则不一致——8 个不相关文件排在前面时，会把唯一被链接的那个挤掉。
    const unrefFiles = Array.from({ length: 8 }, (_, i) => ({
      path: `references/unused-${i}.md`,
      text: `unused ${i}`,
    }));
    const out = parseSkillFiles([
      ...unrefFiles,
      { path: "SKILL.md", text: md("s", ["references/c.md"]) },
      { path: "references/c.md", text: "C" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/c.md"]);
  });

  it("未被 SKILL.md 链接的 references 文件被丢弃——服务端永远不会内联它，带上纯粹浪费 payload", () => {
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("s") }, // 没有任何链接
      { path: "references/orphan.md", text: "no one links me" },
    ]);
    expect(out[0].files).toEqual([{ path: "SKILL.md", content: md("s") }]);
  });
});

describe("parseSkillFiles — 过滤与上限", () => {
  it("丢弃非 .md、evals/、以及没被 SKILL.md 链接的 references", () => {
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("s", ["references/a.md"]) },
      { path: "references/a.md", text: "A" },
      { path: "evals/case1.md", text: "E" },
      { path: "logo.png", text: "binary" },
      { path: "run.sh", text: "#!/bin/sh" },
    ]);
    expect(out[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("SKILL.md 链接超过 8 个 references 时只取前 8（与服务端 extractReferenceLinks 一致）", () => {
    const refPaths = Array.from({ length: 12 }, (_, i) => `references/r${i}.md`);
    const refFiles = refPaths.map((path, i) => ({ path, text: `${i}` }));
    const out = parseSkillFiles([
      { path: "SKILL.md", text: md("s", refPaths) },
      ...refFiles,
    ]);
    const kept = out[0].files.filter((f) => f.path.startsWith("references/"));
    expect(kept).toHaveLength(8);
    // 取的是链接里最先出现的前 8 个，不是任意 8 个
    expect(kept.map((f) => f.path)).toEqual(refPaths.slice(0, 8));
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
    const zip = zipSync({
      "SKILL.md": strToU8(md("z", ["references/r.md"])),
      "references/r.md": strToU8("R"),
    });
    const out = parseSkillFiles(unzipToEntries(zip));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("z");
    expect(out[0].files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/r.md"]);
  });
});

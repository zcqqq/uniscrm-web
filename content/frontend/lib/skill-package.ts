import { unzipSync, strFromU8 } from "fflate";

// 与后端 extractReferenceLinks 同一个上限：内联超过 8 份参考资料的收益递减，而每一份都要
// 进模型的系统提示词。两处保持一致，免得前端放进去、后端又丢掉。
const MAX_REFERENCE_FILES = 8;

export interface UploadFile {
  path: string;
  content: string;
}

export interface ParsedSkill {
  name: string;
  files: UploadFile[];
  bytes: number;
}

export function unzipToEntries(bytes: Uint8Array): { path: string; text: string }[] {
  const unzipped = unzipSync(bytes);
  return Object.entries(unzipped)
    // zip 里的目录是以 "/" 结尾的零长条目，不是文件
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => ({ path, text: strFromU8(data) }));
}

function frontmatterName(text: string): string | null {
  // frontmatter 是文件开头 --- 包起来的 YAML。我们只消费 name 一个字段，用正则取出即可，
  // 不值得为此引入 YAML 解析库。
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const nameLine = fm[1].match(/^name:\s*(.+)$/m);
  return nameLine?.[1].trim().replace(/^["']|["']$/g, "") || null;
}

function keepFile(relPath: string): boolean {
  if (relPath === "SKILL.md") return true;
  return relPath.startsWith("references/") && relPath.endsWith(".md");
}

function buildSkill(dir: string, entries: { path: string; text: string }[]): ParsedSkill {
  const prefix = dir ? `${dir}/` : "";
  const kept: UploadFile[] = [];
  let refCount = 0;
  let main = "";

  for (const e of entries) {
    const rel = e.path.slice(prefix.length);
    if (!keepFile(rel)) continue;
    if (rel === "SKILL.md") {
      main = e.text;
      kept.unshift({ path: rel, content: e.text });
    } else {
      if (refCount >= MAX_REFERENCE_FILES) continue;
      refCount++;
      kept.push({ path: rel, content: e.text });
    }
  }

  const dirName = dir.split("/").filter(Boolean).pop() ?? "";
  const name = frontmatterName(main) ?? dirName;
  return { name, files: kept, bytes: kept.reduce((n, f) => n + f.content.length, 0) };
}

export function parseSkillFiles(entries: { path: string; text: string }[]): ParsedSkill[] {
  // 单个 .md：当成"只有 SKILL.md、没有 references"的技能，名字用文件名。
  if (entries.length === 1 && entries[0].path.endsWith(".md") && !entries[0].path.endsWith("SKILL.md")) {
    const file = entries[0];
    const base = file.path.split("/").pop()!.replace(/\.md$/, "");
    return [{
      name: frontmatterName(file.text) ?? base,
      files: [{ path: "SKILL.md", content: file.text }],
      bytes: file.text.length,
    }];
  }

  // 每个 SKILL.md 决定一个技能目录；根目录的 SKILL.md 对应空前缀。
  const skillDirs = entries
    .filter((e) => e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))
    .map((e) => (e.path === "SKILL.md" ? "" : e.path.slice(0, -"/SKILL.md".length)));

  if (skillDirs.length === 0) {
    throw new Error("No SKILL.md found — expected a skill folder or a package of skill folders");
  }

  return skillDirs.map((dir) =>
    buildSkill(dir, entries.filter((e) => (dir ? e.path.startsWith(`${dir}/`) : true)))
  );
}

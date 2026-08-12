import { unzipSync, strFromU8 } from "fflate";

// 与后端 extractReferenceLinks（content/src/services/skill-content.ts）保持同一份正则和上限——
// 复制而非 import：那个模块还依赖 Env/D1 等只有服务端才有的类型，import 会把服务端依赖打进
// 前端 bundle。两处若失步，服务端的 REFERENCE_LINK_RE / MAX_REFERENCE_FILES 一变这里也要跟着改。
const REFERENCE_LINK_RE = /\]\((references\/[\w./-]+\.md)\)/g;
const MAX_REFERENCE_FILES = 8;

// 从 SKILL.md 正文里解析出它实际链接的 references，按出现顺序去重、上限 8 个——与服务端
// inlineReferencesFromFiles 的选取规则完全一致，这样前端裁的这份文件列表和服务端最终内联的
// 是同一批，而不是"数量凑巧相同"。
function extractReferenceLinks(markdown: string): string[] {
  const seen = new Set<string>();
  for (const m of markdown.matchAll(REFERENCE_LINK_RE)) {
    seen.add(m[1]);
    if (seen.size >= MAX_REFERENCE_FILES) break;
  }
  return [...seen];
}

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

function buildSkill(dir: string, entries: { path: string; text: string }[]): ParsedSkill {
  const prefix = dir ? `${dir}/` : "";
  // 归一化到"技能目录相对路径"，服务端按这个相对路径（如 "references/limits.md"）原样查表。
  const byRel = new Map(entries.map((e) => [e.path.slice(prefix.length), e.text]));

  const main = byRel.get("SKILL.md") ?? "";
  const kept: UploadFile[] = [{ path: "SKILL.md", content: main }];

  // 只保留 SKILL.md 里真正链接到的 references，按链接出现顺序、上限 8。上传了但没被
  // SKILL.md 链接的 references/*.md 服务端永远不会内联（inlineReferencesFromFiles 只查
  // 链接到的路径），带着它纯粹浪费 payload，所以这里直接丢弃，不进 kept。
  for (const ref of extractReferenceLinks(main)) {
    const body = byRel.get(ref);
    if (body === undefined) continue; // 链接指向的文件没随包上传，跳过
    kept.push({ path: ref, content: body });
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

  // 检测规则是 if-elif，根目录优先：根目录有 SKILL.md 就整包只当一个技能，哪怕子目录里还有
  // 别的 SKILL.md 也不拆——不是"每个 SKILL.md 各成一个技能"。子目录 SKILL.md 这时会被当成
  // 普通文件，因为 buildSkill 只认 dir 前缀下的 "SKILL.md"/"references/*.md"，不会误当正文。
  // 用户在 Task 5 的预览里能看到只生成了一个技能，这就是设计好的安全网，不是静默丢数据。
  if (entries.some((e) => e.path === "SKILL.md")) {
    return [buildSkill("", entries)];
  }

  // 否则，每个含 SKILL.md 的子目录各成一个技能。
  const skillDirs = entries
    .filter((e) => e.path.endsWith("/SKILL.md"))
    .map((e) => e.path.slice(0, -"/SKILL.md".length));

  if (skillDirs.length === 0) {
    throw new Error("No SKILL.md found — expected a skill folder or a package of skill folders");
  }

  return skillDirs.map((dir) =>
    buildSkill(dir, entries.filter((e) => e.path.startsWith(`${dir}/`)))
  );
}

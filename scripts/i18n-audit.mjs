// UI 文案双语审计：前端所有用户可见文案必须写成 { en, zh } 内联对象，
// 经 useT()/t() 渲染，中文用户看到的才是中文。
//
// 扫描 7 个租户可见的前端目录（admin 是内部工具、本来就是中文，不扫）。
//
// 做法：把每行里的字符串字面量与 JSX 文本节点都取出来，凡是「看起来像英文文案」的就报——
// 首字母大写且含 2 个以上单词，或单个大写开头的词（Dashboard 这类标题）。
// 技术串（URL、路径、全小写标识、常量名、含 <>{}$ 的模板）按黑名单排除；
// 同行出现 `en:` 的视为已翻译，跳过。
//
// 已知局限（不要误以为它等于「翻完了」）：
//   - 跨行的 JSX 文本（<p>\n  Some text\n</p>）抓不到——按行扫描的固有限制
//   - 单个小写单词、纯符号文案抓不到
//   - 因此审计归零只是必要条件，最终判据是 Task 14 的逐页中文目检
//
// 合理的例外用同行或上一行的 `// i18n-ok: <理由>` 豁免（理由必填）。
//
// CLI: node scripts/i18n-audit.mjs [--check]
//   --check 时若有未豁免项则 exit 1。

import fs from "node:fs";
import path from "node:path";

const DIRS = [
  "web/src",
  "link/frontend",
  "flow/frontend",
  "analytics/frontend",
  "insight-segment/frontend",
  "content/frontend",
  "shared/frontend",
];

// 「Save changes」「Last 7 days」这类：首字母大写，后面还有至少一个词。
const SENTENCE = /^[A-Z][A-Za-z0-9]*(?:[ ,.'’\-—:!?()/&%]+[A-Za-z0-9()][A-Za-z0-9()]*)+[.!?…]?$/;
// 「Dashboard」「Channels」这类单词标题——菜单项和列名大量是这种。
const TITLE_WORD = /^[A-Z][a-z]{2,}$/;

function isTechnical(s) {
  const v = s.trim();
  if (/^https?:\/\//.test(v)) return true;      // URL
  if (/^[/.]/.test(v)) return true;             // 路径
  if (/^[a-z][a-zA-Z0-9]*$/.test(v)) return true; // 全小写标识符
  if (/^[A-Z_]+$/.test(v)) return true;         // 常量名
  if (/^\d/.test(v)) return true;               // 数字开头
  if (/[<>{}$]/.test(v)) return true;           // 模板/标记
  if (/^(GET|POST|PUT|DELETE|PATCH|SELECT|INSERT|UPDATE)\b/.test(v)) return true;
  return false;
}

function looksLikeCopy(s) {
  const v = s.trim();
  if (v.length < 3 || v.length > 200) return false;
  if (isTechnical(v)) return false;
  return SENTENCE.test(v) || TITLE_WORD.test(v);
}

// 一行里出现 en: "..."，说明这行的字符串已经在双语对象里了。
function alreadyBilingual(line) {
  return /\ben\s*:\s*["'`]/.test(line);
}

// 长度限定必须是 * 而不是 {3,200}：同一行里若先出现一个短串（如 value: "a"），
// {3,} 会配不上那对引号，正则就从错误的位置继续，把后面真正的文案整个跳过。
const STR = /"([^"\\\n]*)"|'([^'\\\n]*)'/g;
const JSX_TEXT = />\s*([A-Z][^<>{}\n]{2,}?)\s*</g;

// 这些属性里的字符串是技术值，不是给人看的文案。
const TECH_ATTR = /className|classname|data-|aria-hidden|key=|id=|href=|src=|type=|role=|import\(/;

export function findHardcoded(source, relFile) {
  if (!/\.(tsx|ts)$/.test(relFile)) return [];
  const out = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (alreadyBilingual(line)) continue;
    if (/^\s*(?:import|export\s+\*|export\s+\{)/.test(line)) continue;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;

    const seen = new Set();
    let m;
    STR.lastIndex = 0;
    while ((m = STR.exec(line)) !== null) {
      const text = m[1] ?? m[2];
      if (TECH_ATTR.test(line.slice(Math.max(0, m.index - 30), m.index))) continue;
      if (looksLikeCopy(text) && !seen.has(text)) {
        seen.add(text);
        out.push({ line: i + 1, text: text.slice(0, 80) });
      }
    }
    JSX_TEXT.lastIndex = 0;
    while ((m = JSX_TEXT.exec(line)) !== null) {
      const text = m[1];
      if (looksLikeCopy(text) && !seen.has(text)) {
        seen.add(text);
        out.push({ line: i + 1, text: text.slice(0, 80) });
      }
    }
  }
  return out;
}

export function isExempted(source, line) {
  const lines = source.split("\n");
  const re = /\/\/\s*i18n-ok:\s*\S|\{\/\*\s*i18n-ok:\s*\S/;
  return re.test(lines[line - 1] || "") || re.test(lines[line - 2] || "");
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
}

export function runAudit(root) {
  const files = [];
  for (const d of DIRS) walk(path.join(root, d), files);
  const findings = [], exempted = [], unexempted = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const v of findHardcoded(source, rel)) {
      const rec = { file: rel, ...v };
      findings.push(rec);
      (isExempted(source, v.line) ? exempted : unexempted).push(rec);
    }
  }
  return { findings, exempted, unexempted };
}

function main() {
  const check = process.argv.includes("--check");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { findings, exempted, unexempted } = runAudit(root);
  const byFile = new Map();
  for (const f of unexempted) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${file}`);
  }
  console.log(`\n${findings.length} findings, ${exempted.length} exempted, ${unexempted.length} unexempted`);
  if (check && unexempted.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

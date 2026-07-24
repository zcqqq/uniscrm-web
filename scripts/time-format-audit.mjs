// Timestamp-display audit: all frontend timestamp rendering must go through
// shared/frontend/lib/format-time.ts (formatDate/formatTime/formatDateTime) or
// <DateCell>, so the whole product shows the unified format — date `7/24/2026`,
// time `HH:MM:SS` (24h) in the member's timezone setting.
//
// Flags, in any frontend source file:
//   - .toLocaleDateString( / .toLocaleTimeString(   — always date/time display
//   - new Date(...).toLocaleString(                 — datetime display
//     (bare x.toLocaleString() is NOT flagged: that's number thousands-grouping)
//   - new Intl.DateTimeFormat / Intl.DateTimeFormat( — except timezone
//     detection (`.resolvedOptions()` on the same line)
//
// Exempt a legitimate site with `// time-format-ok: <reason>` on the same or
// previous line (e.g. chart axis labels with granularity-dependent precision).
//
// CLI: node scripts/time-format-audit.mjs [--check]
//   --check exits 1 if any unexempted finding exists.

import fs from "node:fs";
import path from "node:path";

const MODULES = ["admin", "analytics", "content", "flow", "insight-segment", "link", "profile", "trend-skill", "web"];

// The single allowed implementation site.
const ALLOWED = new Set(["shared/frontend/lib/format-time.ts"]);

const PATTERNS = [
  { re: /\.toLocaleDateString\s*\(/, label: "toLocaleDateString" },
  { re: /\.toLocaleTimeString\s*\(/, label: "toLocaleTimeString" },
  { re: /new Date\s*\([^)]*\)\s*\.toLocaleString\s*\(/, label: "new Date().toLocaleString" },
  { re: /Intl\.DateTimeFormat\s*\(/, label: "Intl.DateTimeFormat" },
];

export function findViolations(source, relFile) {
  if (ALLOWED.has(relFile.split(path.sep).join("/"))) return [];
  const out = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, label } of PATTERNS) {
      if (!re.test(line)) continue;
      // timezone detection, not timestamp formatting
      if (label === "Intl.DateTimeFormat" && line.includes("resolvedOptions")) continue;
      out.push({ line: i + 1, label, text: line.trim().slice(0, 120) });
    }
  }
  return out;
}

export function isExempted(source, line) {
  const lines = source.split("\n");
  const re = /\/\/\s*time-format-ok:\s*\S|\{\/\*\s*time-format-ok:\s*\S/;
  return re.test(lines[line - 1] || "") || re.test(lines[line - 2] || "");
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
}

export function runAudit(root) {
  const files = [];
  for (const mod of MODULES) walk(path.join(root, mod, "frontend"), files);
  walk(path.join(root, "web", "src"), files); // web's frontend lives in web/src
  walk(path.join(root, "shared", "frontend"), files);
  const findings = [], exempted = [], unexempted = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const v of findViolations(source, rel)) {
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
  for (const f of unexempted) console.log(`  ${f.file}:${f.line}  [${f.label}]  ${f.text}`);
  console.log(`\n${findings.length} findings, ${exempted.length} exempted, ${unexempted.length} unexempted`);
  if (check && unexempted.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

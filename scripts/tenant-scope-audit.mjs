import fs from "node:fs";
import path from "node:path";

const MODULES = ["admin","analytics","content","flow","insight-segment","link","profile","trend-skill","web"];
const SCOPE_RE = /\btenant_id\b|\bmember_id\b/;

export function tenantScopedTables(migrationSql) {
  const t = new Set();
  for (const sql of migrationSql) {
    for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z_0-9]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      if (/\btenant_id\b/.test(m[2])) t.add(m[1].toLowerCase());
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+([A-Za-z_0-9]+)\s+ADD COLUMN\s+tenant_id/gi)) {
      t.add(m[1].toLowerCase());
    }
  }
  return t;
}

export function extractSqlSites(source) {
  const re = /\.prepare\(\s*([`"'])([\s\S]*?)\1/g;
  const sites = [];
  let m;
  while ((m = re.exec(source))) {
    sites.push({ sql: m[2], offsetStart: m.index, line: source.slice(0, m.index).split("\n").length });
  }
  return sites;
}

function tablesIn(sql) {
  return new Set([...sql.matchAll(/(?:FROM|INTO|UPDATE|JOIN)\s+([A-Za-z_0-9]+)/gi)].map(x => x[1].toLowerCase()));
}

// Walk backwards from the site to the nearest route registration or hard function
// boundary. Returns {inRoute, tainted} — tainted = the handler reads c.req.*.
function routeContext(source, offsetStart) {
  const before = source.slice(0, offsetStart);
  const lines = before.split("\n");
  for (let i = lines.length - 1, budget = 220; i >= 0 && budget > 0; i--, budget--) {
    const line = lines[i];
    if (/(?:router|app)\.(get|post|put|patch|delete)\(/.test(line)) {
      const path0 = (line.match(/["'`]([^"'`]*)["'`]/) || [])[1] || "";
      if (path0.includes("/internal")) return { inRoute: false, tainted: false };
      const body = lines.slice(i).join("\n");
      return { inRoute: true, tainted: /c\.req\.(param|query|json)\(/.test(body) };
    }
    if (/^(?:export )?(?:async )?function |queue\(|scheduled\(/.test(line)) return { inRoute: false, tainted: false };
  }
  return { inRoute: false, tainted: false };
}

export function classifySite({ sql, source, offsetStart, file, tenantTables }) {
  const base = path.basename(file);
  if (base === "cron.ts" || base === "routes-internal.ts")
    return { finding: false, severity: null, reason: "cron/internal file" };
  const hit = [...tablesIn(sql)].filter(t => tenantTables.has(t));
  if (hit.length === 0) return { finding: false, severity: null, reason: "no tenant-scoped table" };
  if (SCOPE_RE.test(sql)) return { finding: false, severity: null, reason: "has tenant_id/member_id" };
  const { inRoute, tainted } = routeContext(source, offsetStart);
  if (!inRoute) return { finding: false, severity: null, reason: "not in a user-facing route" };
  return { finding: true, severity: tainted ? "error" : "warn", reason: `unscoped ${hit.join(",")} in route${tainted ? " reading req input" : ""}` };
}

export function isExempted(source, line) {
  const lines = source.split("\n");
  const re = /\/\/\s*tenant-scope-ok:\s*\S/;
  const cur = lines[line - 1] || "";
  const prev = lines[line - 2] || "";
  return re.test(cur) || re.test(prev);
}

// R2 SQL (Iceberg) queries are built as `query: `SELECT … WHERE tenant_id = …``
// inside a fetch to /r2-sql/query. Find each query literal near such a fetch.
export function r2SqlSites(source) {
  const sites = [];
  for (const m of source.matchAll(/r2-sql\/query/g)) {
    const window = source.slice(m.index, m.index + 1200);
    const q = window.match(/query:\s*([`"'])([\s\S]*?)\1/);
    if (q) sites.push({ query: q[2], offsetStart: m.index, line: source.slice(0, m.index).split("\n").length });
  }
  return sites;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
}

export function runAudit(root) {
  const migrations = [];
  for (const mod of MODULES) {
    const md = path.join(root, mod, "migrations");
    if (fs.existsSync(md)) for (const f of fs.readdirSync(md)) if (f.endsWith(".sql")) migrations.push(fs.readFileSync(path.join(md, f), "utf8"));
  }
  const tenantTables = tenantScopedTables(migrations);
  const files = [];
  for (const mod of MODULES) { walk(path.join(root, mod, "src"), files); walk(path.join(root, mod, "worker"), files); }
  const findings = [], exempted = [], unexempted = [];
  const push = (rec, source, line) => { findings.push(rec); (isExempted(source, line) ? exempted : unexempted).push(rec); };
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const site of extractSqlSites(source)) {
      const c = classifySite({ sql: site.sql, source, offsetStart: site.offsetStart, file: rel, tenantTables });
      if (!c.finding) continue;
      push({ file: rel, line: site.line, sql: site.sql.replace(/\s+/g, " ").slice(0, 100), severity: c.severity }, source, site.line);
    }
    for (const r of r2SqlSites(source)) {
      if (/\btenant_id\b/.test(r.query)) continue;
      push({ file: rel, line: r.line, sql: `[R2-SQL] ${r.query.replace(/\s+/g, " ").slice(0, 90)}`, severity: "error" }, source, r.line);
    }
  }
  return { findings, exempted, unexempted };
}

function main() {
  const check = process.argv.includes("--check");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { findings, exempted, unexempted } = runAudit(root);
  for (const f of unexempted) console.log(`  ${f.severity.toUpperCase()}  ${f.file}:${f.line}  ${f.sql}`);
  console.log(`\n${findings.length} findings, ${exempted.length} exempted, ${unexempted.length} unexempted`);
  if (check && unexempted.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

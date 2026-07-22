# Tenant-Scope Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A repo-root static audit that fails when a user-facing route queries a shared-D1 tenant-scoped table (or an R2-SQL Iceberg table) without a `tenant_id`/`member_id` constraint, silenceable only by a reasoned in-code exemption comment.

**Architecture:** One dependency-free ESM script, `scripts/tenant-scope-audit.mjs`, exporting pure functions (schema parse → SQL-site extract → classify) plus a `--check` CLI. Tenant-scoped table names are derived from `*/migrations/*.sql` at runtime — never hardcoded. Unit-tested with Node 24's built-in `node --test`. Report-only by default; `--check` exits non-zero on unexempted findings. Rollout flips the gate on only after today's 20 findings are triaged (1 fixed, 19 exempted).

**Tech Stack:** Node 24 (built-in `node:test`, `node:fs`), plain regex parsing. No new npm dependencies.

## Global Constraints

- **No new npm dependencies.** Root `package.json` is CommonJS; the script is `.mjs` (ESM) and uses only Node built-ins. (稳定、少改动、低价)
- **Never commit to `main` without the user's explicit "push to main".** Current branch is `main` — do all work uncommitted, or on a branch only if the user asks. Steps that say "commit" mean **stage locally / prepare the commit**; do not push to `main`.
- **Tenant-scoped table list is derived from migrations**, not hardcoded. If a migration adds a `tenant_id` column, the audit must pick it up with no code change.
- **`member_id` is equivalent to `tenant_id`** for scoping (a member belongs to one tenant).
- **Pass = zero unexempted findings.** An exemption is `// tenant-scope-ok: <reason>` with a non-empty reason on the same or preceding line; a bare `tenant-scope-ok` does not exempt.
- **Audit roots:** scan `*/src/**` and `*/worker/**` for `.ts`, excluding `node_modules`, `*.test.ts`, `dist`. Migrations from `*/migrations/*.sql`.
- **Route context:** a finding requires the SQL site be lexically inside a `router.<verb>(` or `app.<verb>(` handler, NOT under a path containing `/internal`, and NOT in a file named `cron.ts` or `routes-internal.ts`.
- Modules: `admin analytics content flow insight-segment link profile trend-skill web`.

---

### Task 1: The audit script + classifier unit tests

Delivers the whole mechanism in report-only form. One reviewable unit: the parser, the classifier, the CLI, and the `node --test` suite that pins the classifier's logic. A reviewer can reject the classification rules independently of any exemption work.

**Files:**
- Create: `scripts/tenant-scope-audit.mjs`
- Test: `scripts/tenant-scope-audit.test.mjs`

**Interfaces:**
- Produces (all exported from `tenant-scope-audit.mjs`):
  - `tenantScopedTables(migrationSql: string[]): Set<string>` — union of table names whose `CREATE TABLE` body or `ALTER TABLE … ADD COLUMN` mentions `tenant_id`. Lowercased.
  - `extractSqlSites(source: string): {sql: string, line: number, offsetStart: number}[]` — every `.prepare(<string-literal>)` with backtick/single/double quotes.
  - `classifySite(args: {sql, source, offsetStart, file, tenantTables: Set<string>}): {finding: boolean, severity: 'error'|'warn'|null, reason: string}` — applies the Global-Constraints route/exempt rules. `reason` explains why it is or isn't a finding.
  - `isExempted(source: string, line: number): boolean` — true iff same or preceding line has `// tenant-scope-ok:` followed by non-whitespace.
  - `r2SqlSites(source: string): {query: string, line: number, offsetStart: number}[]` — every `r2-sql/query` fetch's `query:` string literal.
  - `runAudit(root: string): {findings, exempted, unexempted}` — walks the tree, returns arrays of `{file, line, sql, severity}`; includes both D1 `.prepare` findings and R2-SQL findings.
  - CLI: `node scripts/tenant-scope-audit.mjs [--check]`. Always prints the census `N findings, M exempted, K unexempted`. Exits 0 by default; with `--check`, exits 1 iff `unexempted.length > 0`.

- [ ] **Step 1: Write the failing classifier tests**

`scripts/tenant-scope-audit.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tenantScopedTables, extractSqlSites, classifySite, isExempted, r2SqlSites,
} from "./tenant-scope-audit.mjs";

const TT = new Set(["channels", "flows", "flow_pending", "members"]);

test("tenantScopedTables reads CREATE TABLE and ALTER ADD COLUMN", () => {
  const s = tenantScopedTables([
    "CREATE TABLE channels (id TEXT, tenant_id INTEGER);",
    "CREATE TABLE logs (id TEXT);",
    "ALTER TABLE flows ADD COLUMN tenant_id INTEGER;",
  ]);
  assert.ok(s.has("channels"));
  assert.ok(s.has("flows"));
  assert.ok(!s.has("logs"));
});

test("extractSqlSites finds backtick/quote prepares with line numbers", () => {
  const src = "a\nx.prepare(`SELECT 1 FROM channels`)\ny.prepare(\"UPDATE flows SET a=1\")";
  const sites = extractSqlSites(src);
  assert.equal(sites.length, 2);
  assert.equal(sites[0].line, 2);
});

test("unscoped query in a route reading req input is an error finding", () => {
  const src = [
    'router.get("/x/status", async (c) => {',
    '  const id = c.req.param("id");',
    '  await c.env.LINK_DB.prepare("SELECT config FROM channels WHERE id = ?").bind(id).first();',
    "});",
  ].join("\n");
  const site = extractSqlSites(src)[0];
  const r = classifySite({ sql: site.sql, source: src, offsetStart: site.offsetStart, file: "link/src/routes-channels.ts", tenantTables: TT });
  assert.equal(r.finding, true);
  assert.equal(r.severity, "error");
});

test("scoped query (tenant_id present) is not a finding", () => {
  const src = [
    'router.get("/x/status", async (c) => {',
    '  await c.env.LINK_DB.prepare("SELECT config FROM channels WHERE tenant_id = ?").bind(t).first();',
    "});",
  ].join("\n");
  const site = extractSqlSites(src)[0];
  const r = classifySite({ sql: site.sql, source: src, offsetStart: site.offsetStart, file: "link/src/routes-channels.ts", tenantTables: TT });
  assert.equal(r.finding, false);
});

test("member_id counts as tenant scope", () => {
  const src = [
    'router.get("/", async (c) => {',
    '  await c.env.WEB_DB.prepare("SELECT x FROM members WHERE id = ?").bind(m).first();',
    "});",
  ].join("\n");
  // members table + WHERE id — but member_id absent; still a finding unless exempted.
  const site = extractSqlSites(src)[0];
  const r = classifySite({ sql: site.sql, source: src, offsetStart: site.offsetStart, file: "web/worker/api/settings.ts", tenantTables: TT });
  assert.equal(r.finding, true); // exempted later via comment, not by heuristic
});

test("cron file is ignored", () => {
  const src = 'db.prepare("SELECT id FROM channels WHERE is_active = 1").all();';
  const site = extractSqlSites(src)[0];
  const r = classifySite({ sql: site.sql, source: src, offsetStart: site.offsetStart, file: "link/src/cron.ts", tenantTables: TT });
  assert.equal(r.finding, false);
});

test("/internal route path is ignored", () => {
  const src = [
    'app.post("/internal/flows/:id", async (c) => {',
    '  await c.env.FLOW_DB.prepare("DELETE FROM flow_pending WHERE flow_id = ?").bind(x).run();',
    "});",
  ].join("\n");
  const site = extractSqlSites(src)[0];
  const r = classifySite({ sql: site.sql, source: src, offsetStart: site.offsetStart, file: "flow/src/index.ts", tenantTables: TT });
  assert.equal(r.finding, false);
});

test("query on a non-tenant table is ignored", () => {
  const src = 'router.get("/", c => c.env.DB.prepare("SELECT 1 FROM logs WHERE id = ?").bind(x));';
  const site = extractSqlSites(src)[0];
  const r = classifySite({ sql: site.sql, source: src, offsetStart: site.offsetStart, file: "web/worker/api/x.ts", tenantTables: TT });
  assert.equal(r.finding, false);
});

test("isExempted honours reasoned marker, rejects bare marker", () => {
  const good = "// tenant-scope-ok: id bound to session memberId\nx.prepare(...)";
  assert.equal(isExempted(good, 2), true);
  const bare = "// tenant-scope-ok\nx.prepare(...)";
  assert.equal(isExempted(bare, 2), false);
  const sameLine = 'x.prepare("...") // tenant-scope-ok: external webhook';
  assert.equal(isExempted(sameLine, 1), true);
});

test("r2SqlSites extracts the query literal; unscoped R2-SQL is a finding", () => {
  const scoped = 'fetch(url + "/r2-sql/query/" + wh, { body: JSON.stringify({ query: `SELECT id FROM u WHERE tenant_id = ${t}` }) })';
  const unscoped = 'fetch(url + "/r2-sql/query/" + wh, { body: JSON.stringify({ query: `SELECT id FROM u LIMIT 10` }) })';
  assert.equal(r2SqlSites(scoped).length, 1);
  assert.ok(/tenant_id/.test(r2SqlSites(scoped)[0].query));
  assert.ok(!/tenant_id/.test(r2SqlSites(unscoped)[0].query));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/tenant-scope-audit.test.mjs`
Expected: FAIL — `Cannot find module … tenant-scope-audit.mjs` (or export-not-found).

- [ ] **Step 3: Implement the script**

`scripts/tenant-scope-audit.mjs`:

```js
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

// R2 SQL (Iceberg) queries are built as `query: \`SELECT … WHERE tenant_id = …\``
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/tenant-scope-audit.test.mjs`
Expected: PASS — all classifier tests green.

- [ ] **Step 5: Run the audit against the real tree (report-only sanity check)**

Run: `node scripts/tenant-scope-audit.mjs`
Expected: prints ~20 route-level findings and a census line ending `… unexempted`. Exit 0. (Confirms it reproduces the triage set from the spec.)

- [ ] **Step 6: Stage the commit (do NOT push to main)**

```bash
git add scripts/tenant-scope-audit.mjs scripts/tenant-scope-audit.test.mjs
# prepare message; commit only if the user has said "push to main" or asked for a branch:
# git commit -m "feat(scripts): tenant-scope static audit (report-only)"
```

---

### Task 2: Triage exemptions — drive unexempted to zero

Adds the 19 reasoned exemption comments from the spec's triage table so `--check` can be turned on. The flow unpublish bug (#1 in the table) was already fixed this session, so it is NOT in this task. Each comment states *why* the site is safe — several double as the load-bearing note for a future editor.

**Files (modify — add one comment line above each cited `.prepare(`):**
- `insight-segment/src/index.ts:199,225,234` → `// tenant-scope-ok: segmentId ownership verified by SELECT … tenant_id at L191-197`
- `analytics/src/index.ts:325` → `// tenant-scope-ok: dashboard ownership verified at L320-323`
- `link/src/oauth.ts:193,199` → `// tenant-scope-ok: byokChannelId ownership verified by tenant-scoped credential lookup above`
- `link/src/oauth.ts:268,390,509,561` → `// tenant-scope-ok: keyed by OAuth-authenticated source_channel_id, not caller input`
- `link/src/webhook.ts:362` → `// tenant-scope-ok: external X webhook, authed by provider signature not session`
- `web/worker/api/auth.ts:65` → `// tenant-scope-ok: registration INSERT, no tenant exists yet`
- `link/src/routes-channels.ts:138` → `// tenant-scope-ok: UPDATE after existing-row tenant check above`
- `link/src/routes-channels.ts:155` → `// tenant-scope-ok: intentional global probe for cross-tenant channel-id collision`
- `web/worker/api/settings.ts:23,37,60,75` → `// tenant-scope-ok: id bound to session memberId (the scoping key)`

(Exact line numbers will have shifted by earlier edits in this session; locate each cited `.prepare(` by its SQL text, not the frozen line number.)

- [ ] **Step 1: Re-run the audit to get the current unexempted list**

Run: `node scripts/tenant-scope-audit.mjs`
Expected: a census with `~19 unexempted` (20 minus the already-fixed flow bug). Note each file:line.

- [ ] **Step 2: Add each exemption comment**

For every site above, insert the given `// tenant-scope-ok: <reason>` on the line directly above its `.prepare(` call. Verify each reason matches the actual guard in the surrounding code before writing it (do not paste a reason you haven't confirmed against the code).

- [ ] **Step 3: Verify unexempted is zero**

Run: `node scripts/tenant-scope-audit.mjs`
Expected: census ends `… 19 exempted, 0 unexempted`.

- [ ] **Step 4: Verify the gate now passes**

Run: `node scripts/tenant-scope-audit.mjs --check; echo "exit=$?"`
Expected: `exit=0`.

- [ ] **Step 5: Sanity — the gate still fails when a real gap is introduced**

Temporarily delete one exemption comment, run `node scripts/tenant-scope-audit.mjs --check; echo "exit=$?"` → expect `exit=1`. Restore the comment.

- [ ] **Step 6: Stage the commit (do NOT push to main)**

```bash
git add insight-segment/src/index.ts analytics/src/index.ts link/src/oauth.ts link/src/webhook.ts web/worker/api/auth.ts link/src/routes-channels.ts web/worker/api/settings.ts
# git commit -m "chore: annotate tenant-scope-ok exemptions to enable audit gate"
```

---

### Task 3: Wire the gate into CI

One lightweight step in the dev deploy, gated by `--check`. Prod deploy is user-triggered and out of scope for this task.

**Files:**
- Modify: `.github/workflows/deploy-dev.yml`

**Interfaces:**
- Consumes: `scripts/tenant-scope-audit.mjs --check` (Task 1), returning 0 now that Task 2 zeroed unexempted.

- [ ] **Step 1: Add a pre-deploy audit job**

Add near the top of `deploy-dev.yml`'s jobs (before `deploy`), so a regression blocks the deploy:

```yaml
  tenant-scope-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - name: Tenant-scope audit
        run: node scripts/tenant-scope-audit.mjs --check
```

Then add `needs: tenant-scope-audit` to the existing `deploy` job (merge with any existing `needs` list).

- [ ] **Step 2: Lint the workflow locally**

Run: `node -e "const y=require('fs').readFileSync('.github/workflows/deploy-dev.yml','utf8'); if(!/tenant-scope-audit/.test(y)) throw new Error('job missing'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Stage the commit (do NOT push to main)**

```bash
git add .github/workflows/deploy-dev.yml
# git commit -m "ci(dev): gate deploy on tenant-scope audit"
```

Note: this job runs only after a push to `main` (deploy-dev trigger). Confirm the census/exit behavior locally first; the first real CI run happens when the user pushes to main.

---

## Self-Review

**Spec coverage:**
- Schema-from-migrations → Task 1 `tenantScopedTables`. ✓
- Literal-SQL extraction → `extractSqlSites`. ✓
- Route/`/internal`/cron classification + severity → `classifySite` + tests. ✓
- Exemption comments (reason mandatory, bare rejected) → `isExempted` + test. ✓
- Report-only default vs `--check` gate → `main()` + Task 2 Step 4/5. ✓
- Triage of the 20 (1 fixed, 19 exempted) → flow bug excluded (already fixed); 19 in Task 2. ✓
- R2-SQL check → Task 1 `r2SqlSites` + fixture test + `runAudit` inclusion. Fixture-tested (no live positive needed, since all 3 real sites are scoped); the rule still guards against a future unscoped one. ✓
- CI wiring → Task 3. ✓

**Placeholder scan:** none — all steps carry runnable code/commands.

**Type consistency:** `runAudit`/`classifySite`/`isExempted`/`extractSqlSites`/`tenantScopedTables`/`r2SqlSites` names identical across script, tests, and interface blocks. ✓

**Scope note:** covers shared D1 + R2-SQL (Iceberg), matching the user's chosen scope. Tenant DB (physically isolated) and R2 object keys (out of scope for v1) are excluded by design, per the spec's non-goals.

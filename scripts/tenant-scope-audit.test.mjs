import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tenantScopedTables, extractSqlSites, classifySite, isExempted, r2SqlSites,
} from "./tenant-scope-audit.mjs";

const TT = new Set(["channels", "flows", "flow_pending", "members"]);

test("tenantScopedTables reads CREATE TABLE and ALTER ADD COLUMN", () => {
  const s = tenantScopedTables([
    "CREATE TABLE channels (id TEXT, tenant_id INTEGER\n);",
    "CREATE TABLE logs (id TEXT\n);",
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

test("member_id counts as tenant scope (member table WHERE id still flagged)", () => {
  const src = [
    'router.get("/", async (c) => {',
    '  await c.env.WEB_DB.prepare("SELECT x FROM members WHERE id = ?").bind(m).first();',
    "});",
  ].join("\n");
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

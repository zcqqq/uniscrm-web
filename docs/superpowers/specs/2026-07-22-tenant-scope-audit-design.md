# Tenant-Scope Audit — Design

**Date:** 2026-07-22
**Status:** design approved, implementation pending
**Author:** session with Claude

## Problem

`uniscrm-web` is a multi-tenant SaaS. Tenant data lives in three places:

1. **Shared D1** (`WEB_DB`, `LINK_DB`, `FLOW_DB`, `ADMIN_DB`, `ANALYTICS_DB`, `CONTENT_DB`, `TREND_DB`) — one physical DB holding every tenant's rows, isolated only by a `tenant_id`/`member_id` column and a correct `WHERE` clause.
2. **Tenant DB** (`TenantDataDB`) — one physical D1 per tenant, constructed from the session's own `d1_database_id`. **Physically isolated; not a risk surface.**
3. **R2 Data Catalog (Iceberg)** — big shared tables queried by R2 SQL with `WHERE tenant_id = …`.

The recurring defect: a user-facing route reads a caller-supplied id and queries a shared-D1 tenant-scoped table **without** also constraining by the session's tenant. Five such bugs were found and fixed in `link` on 2026-07-22 (X status leak, `DELETE /x` cross-tenant deactivate, `/x/connect` + `/x/callback` BYOK credential/write leak). All were in code untouched for months — an edit-time check would not have caught any of them, which is why this must be a **whole-codebase static audit**, not a hook.

### Measured scope (2026-07-22, real tree)

```
312  .prepare() call sites across 9 modules
254  touch a table that has a tenant_id column (per migrations)
 79  ...and carry no tenant_id/member_id predicate in the SQL
 20  ...and sit inside a user-facing route handler   ← audited, see triage
 14  ...and also read c.req.param/query/json
```

Naive text-grep flags 237/312 (76% noise). Schema-filtering + context-classification cuts that to a 20-item reviewable list.

## Non-goals

- Tenant DB (`TenantDataDB`) queries — physically isolated, out of scope.
- R2 **object** keys (e.g. `video-action-jobs/${jobId}/…`) — only 5 sites, no tenant prefix today; revisit when the surface grows. Out of scope for v1.
- A full taint tracker. This is a tripwire, not a theorem prover.

## Mechanism

A single Node script, `scripts/tenant-scope-audit.mjs`, runnable directly (`node scripts/tenant-scope-audit.mjs`) with a `--check` flag that exits non-zero on unexempted findings. Its unit tests use Node 24's built-in test runner (`node --test`) — **zero new dependencies**; the repo root is a CommonJS `package.json` with no vitest, so an `.mjs` (ESM) script + `node --test` is lighter than adding vitest there. Placed at repo root under `scripts/` (not `operation/`, whose semantics are "prod data-fix scripts") because the audit is inherently cross-module.

Four stages:

1. **Schema truth.** Parse every `*/migrations/*.sql`; a table is *tenant-scoped* if a `CREATE TABLE` body or `ALTER TABLE … ADD COLUMN` mentions `tenant_id`. No hardcoded table list — it tracks the migrations. (2026-07-22: 25 such tables.)
2. **Extract SQL sites.** Regex `.prepare(<string-literal>)` across `*/src` and `*/worker`; capture SQL, file, line, referenced tables.
3. **Classify.** A **finding** = touches a tenant-scoped table AND no `tenant_id`/`member_id` predicate AND lexically inside a `router.<verb>(`/`app.<verb>(` handler NOT under `/internal/*` AND not in a `cron.ts`/`routes-internal.ts` file. Reading `c.req.param/query/json` in the handler upgrades severity `warn`→`error`.
4. **R2 SQL.** Any `r2-sql/query` fetch whose query body lacks `tenant_id` is a finding.

### Exemption mechanism (in-code comments)

A finding is silenced by a comment on the same or preceding line:

```ts
// tenant-scope-ok: <reason>
```

- The reason is **mandatory** — a bare `tenant-scope-ok` is itself a failure.
- The audit prints a census: `N findings, M exempted, K unexempted`. Exemptions are visible, reviewable in one place, and sit next to the code they excuse.
- **Pass = zero unexempted findings.** Turning the gate on therefore requires triaging today's 20 first.

Rejected alternative — a **baseline file**: it freezes today's real bugs as "known" far from the code, which is exactly how the 5 `link` bugs survived. In-code comments keep the reason at the defect site.

## Honest limits (must stay in the spec)

1. **Literal SQL only.** `.prepare(\`...${dynamicTable}...\`)` is invisible. Acceptable — tenant-scoped tables are all queried by literal SQL today.
2. **Guarded-by-earlier-check sites stay flagged forever.** Many safe sites (e.g. `oauth.ts` BYOK write, `insight-segment` compute UPDATEs) do `WHERE id = ?` and are safe only because an ownership `SELECT … WHERE id = ? AND tenant_id = ?` above them 404s a non-owner first. The audit can't see that data-flow, so these carry a standing `tenant-scope-ok: guarded by ownership check at line NNN` — which doubles as the load-bearing-comment for the next editor.
3. **Not a taint tracker.** "In a route + reads req input" is a heuristic: false positives (exempt them) and it can miss a bug where the tainted id is laundered through a helper.
4. **`member_id` ≡ `tenant_id`.** A member belongs to one tenant, so `WHERE member_id = ?` is tenant-safe.

## Rollout (respects "稳定、少改动" + GitHub Actions quota)

1. Land the script + its own `node --test` unit tests (fixture snippets: scoped route → pass; unscoped route reading req → error; cron file → ignored; `/internal/` route → ignored; exempted line → pass; bare-marker → fail). Default run is **report-only** (exit 0); `--check` is what exits non-zero.
2. Triage today's 20 (see below) — fix real bugs, exempt legitimate patterns.
3. Enable the gate by running with `--check` once unexempted count is 0.
4. Wire into `deploy-dev.yml` as one lightweight pre-deploy step: `node scripts/tenant-scope-audit.mjs --check`.

Steps 2–4 are separate approvals.

## Triage of the 20 route-level findings (audited 2026-07-22)

**Result: 1 real bug, 19 legitimate patterns.** The real bug was fixed this session (with a fail-then-pass test); the 19 get exemption comments in rollout step 2.

| # | Site | Verdict | Reason |
|---|------|---------|--------|
| 1 | `flow/src/index.ts:1288` (unpublish) | **BUG — FIXED** | Deleted `flow_pending` by `flow_id` without gating on ownership; UPDATE above lacked `meta.changes` check. Fixed to mirror `DELETE /api/flows/:id`. Test: `flow/tests/unit/unpublish-tenant-isolation.test.ts`. |
| 2 | `flow/src/index.ts:1261` (delete) | safe | Guarded by `if(!result.meta.changes) return 404` at :1259. |
| 3–5 | `insight-segment/src/index.ts:199,225,234` | safe | Guarded by `SELECT … WHERE id=? AND tenant_id=?` at :191-197. |
| 6 | `analytics/src/index.ts:325` | safe | Guarded by dashboard ownership `SELECT … tenant_id` at :320-323. |
| 7–8 | `link/src/oauth.ts:193,199` | safe | Guarded by the tenant-scoped BYOK credential lookup added this session. |
| 9–12 | `link/src/oauth.ts:268,390,509,561` | safe | Keyed by `source_channel_id` = the just-OAuth-authenticated external account id; not caller-controlled. |
| 13 | `link/src/webhook.ts:362` | safe | External X webhook (CRC challenge), authed by provider signature, not a session. Heuristic misread `router.get` as a user route. |
| 14 | `web/worker/api/auth.ts:65` | safe | `INSERT INTO tenants` at registration — no tenant exists yet. |
| 15–16 | `link/src/routes-channels.ts:138,155` | safe | :138 UPDATE after `existing` tenant check; :155 is an intentional global cross-tenant collision probe. |
| 17–20 | `web/worker/api/settings.ts:23,37,60,75` | safe | `WHERE id = ?` bound to the **session** `memberId`, which is the tenant-scoping key. |

R2 SQL: 3 `r2-sql/query` sites; 2 carry `tenant_id`, 1 (`link/src/routes-users.ts`) does — re-confirmed scoped. Track any future unscoped one via the same audit.

## Files

| File | Action |
|------|--------|
| `scripts/tenant-scope-audit.mjs` | new — the audit (library exports + `--check` CLI) |
| `scripts/tenant-scope-audit.test.mjs` | new — classifier unit tests via `node --test` |
| 19 source sites (table above) | add `// tenant-scope-ok: <reason>` in rollout step 2 |
| `.github/workflows/deploy-dev.yml` | add pre-deploy `node … --check` step in rollout step 4 |

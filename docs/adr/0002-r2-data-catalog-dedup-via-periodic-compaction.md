# Dedup R2 Data Catalog tables via periodic PyIceberg compaction, not at write time

R2 Pipelines sinks (`INSERT INTO sink SELECT * FROM stream`) are append-only — there is no
upsert/merge on write, and R2 SQL itself is read-only (no UPDATE/MERGE/DELETE). So any poller
or webhook that resends an unchanged row (X's `get-followers`/`get-posts` incremental polls,
for example) creates a duplicate row in the Iceberg table rather than updating one in place.

We considered query-time dedup (e.g. `ROW_NUMBER() OVER (PARTITION BY ...)` at read time) but
rejected it: every analytics query would need to repeat the same window-function logic, and
query cost grows with the accumulated duplicate count forever.

Decision: run a periodic job (`analytics/compactor`, a Flask+PyIceberg container hit from the
`analytics` Worker's daily cron) that loads the full table via the Iceberg REST Catalog
protocol, drops duplicates by business key keeping the latest `updated_at`, and calls
`table.overwrite()` — the only interface in this stack that can actually write/merge Iceberg
tables (R2 SQL/Pipelines cannot). Source-side upsert code is still expected to gate pipeline
sends on an actual change (see `x-users.ts`/`content.ts`'s `unchanged` check) to keep the
duplicate rate down between compaction runs, but compaction is the backstop, not the sends
being fixed.

This pattern applies to every R2-Data-Catalog-backed table fed by a poller/webhook in this
codebase (`uniscrm.user`, `uniscrm.content`, and any future one) — not a one-off for `user`.

**2026-07-25 更新**:读路径改用 `QUALIFY ROW_NUMBER() OVER (PARTITION BY <业务键>
ORDER BY updated_at DESC) = 1` 之后,compaction 不再承担读取正确性,只是存储优化 ——
两次 compaction 之间的重复行由查询自己滤掉。`compactContentTable` 的 `key_columns`
同步补上了 `list_id`,与读路径的 PARTITION BY 保持一致 —— 更窄的 compaction key
会把同一篇内容在两个不同 list 下被抓到的行错误合并成一行。见
`docs/adr/0005-tenant-db-removed-r2-as-single-source.md`。

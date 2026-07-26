# Prod cutover runbook — user/content 回 per-tenant D1

来源:2026-07-26 迁移的最终整分支 review(含实测验证)。按阶段顺序执行,
每个 Phase 的门禁不满足就停。dev 已全量验证;本文只覆盖 prod。

## Phase 0 — 预检(只读)

```bash
# ⟳ 确认映射仍与存档一致,任何不符即中止:
wrangler d1 execute uniscrm-web --env production --config web/wrangler.toml --remote \
  --command "SELECT tenant_id, d1_database_id FROM tenants ORDER BY tenant_id"
#   期望 1→f5f49e47-d779-49a0-b609-f2b2ab5fd09f
#        100000→ce377715-5196-4ad7-b2d7-a52a75a734d6
#        100001→b8656ee3-3e93-4d8c-b782-0508a824d549
# ⟳ 确认迁移账本仍停在 0006:
wrangler d1 execute uniscrm-web --env production --config web/wrangler.toml --remote \
  --command "SELECT name FROM d1_migrations ORDER BY id"
```

已实测无需处理:三个租户库的 partial unique 索引与 `ON CONFLICT` 目标完全一致;
`status` 可空带默认;`raw_data NOT NULL DEFAULT '{}'`;`post_count` 已就位;
`channel_id IS NULL` 的 content 行为 0(旧计划里的一次性回填**不需要**)。
缺口只有 `user.verified_type`(Phase 3 处理)。

**带外确认(Phase 4 前必须)**:prod link worker 的 `INTERNAL_SECRET` 实际值——
`link/wrangler.toml` 的 vars 里是占位符 `prod-internal-secret-change-me`;若线上就是它,先轮换。
`/internal/backfill/pipeline` 依赖这一道门。

## Phase 1 — 重建三张 prod R2 表(是**部署**的前置,不只是回填的)

按 `analytics/pipelines/rebuild-tables.md`(旁置改名,不 drop;删除顺序 pipeline→sink→stream;
用当前 `*-stream-schema.json` 重建;stream ID 会变,`link/wrangler.toml` env.production 的
`[[pipelines]]` 绑定按 ID 替换)。
门禁原因:prod `uniscrm.user` 仍是旧 schema(缺 `profile_image_url`/`description`/`raw_data`/
`is_deleted`,多 `profile_id`)——新 `buildUserRecord` 发的记录会被拒收,读路径的
`is_deleted = 0` 也会直接报错。现存数据量:user 1 / content 0 / event 8,无可惜。

## Phase 2 — WEB_DB 迁移(推荐无损变体)

0008+0009 是一对精确的 no-op(prod 列已在且值正确)。直接把它们标记为已应用,只让 0007 跑:

```bash
wrangler d1 execute uniscrm-web --env production --config web/wrangler.toml --remote --command \
  "INSERT INTO d1_migrations (name) VALUES ('0008_drop_tenant_d1_column.sql'), ('0009_restore_tenant_d1_column.sql')"
wrangler d1 migrations apply uniscrm-web --env production --config web/wrangler.toml --remote  # 仅 0007
wrangler d1 execute uniscrm-web --env production --config web/wrangler.toml --remote \
  --command "SELECT COUNT(*) FROM tenants WHERE d1_database_id IS NOT NULL"   # 必须 = 3
```

回退方案(仅当账本 INSERT 被拒):连跑三条后**立刻**用 Phase 0 存档的三条 UPDATE 回填,
期间所有租户 D1 访问处于 503 窗口。

## Phase 3 — 租户库迁移(0006 verified_type)——先于任何 prod user 写入

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  node --experimental-strip-types operation/migrate-tenant-dbs.ts production
#   期望 tenantCount: 3, failed: 0 —— tenantCount 0 现在会非零退出(修复后),那是失败不是成功
```

首次手动执行,不交给 CI(CI job 已修为 needs: [sync-secrets, migrate],但首跑仍应人工盯)。

## Phase 4 — 部署

手动触发 Deploy Production workflow。`migrate` 为 no-op,`migrate-tenant-dbs` 经
`_tenant_migrations` 跳过三库。此步骤首次把 `/internal/backfill/pipeline` 发到 prod——
INTERNAL_SECRET 未确认前不要进行。

## Phase 5 — 回填前先验证写路径

等一个 cron tick:

```bash
wrangler d1 execute uniscrm-t1 --remote --command "SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM user"
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm "SELECT COUNT(DISTINCT id) AS c FROM uniscrm.user"
```

D1 应越过 355 且时间戳新;R2 新表应出现非零行。先回填只会把 schema 问题搅浑。

## Phase 6 — R2 副本回填(逐租户)

按 `task-9b` 模式对 `1 100000 100001` 执行(100000 为空可跳过):dump(注意 user 的 SELECT 含
`verified_type`,**必须在 Phase 3 之后**)→ `backfill-users.mts` / `backfill-content.mts` 转换 →
分批(≤200)POST `https://link.uni-scrm.com/internal/backfill/pipeline`(X-Internal-Secret)。
每个响应必须 `{"ok":true}`;502 = 该批被丢,必须重发。等 sink 滚动后:

```bash
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm "SELECT COUNT(DISTINCT id) AS c FROM uniscrm.user"     # ≥356
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm "SELECT COUNT(DISTINCT id) AS c FROM uniscrm.content"  # ≥40
```

一律 `COUNT(DISTINCT id)`(Pipelines at-least-once,少量超出正常且随 compaction 收敛)。

## Phase 7 — 本 runbook 之后仍冻结

`profile` worker 与 `uniscrm-maigret` 队列的删除另行决定。
**删除四个 uniscrm-t* 库:永久取消。**

## 备用:list_users 旧 uuid 孤儿(当前两环境均为 0 行,无需执行)

若未来出现:`UPDATE list_users SET user_id = (SELECT es.source_id FROM entity_state es
WHERE es.entity='user' AND es.entity_id = list_users.user_id)` 可把 claim-uuid 归一到
source id 域,现有 resolver 即可解析。

# Prod cutover runbook — user/content 回 per-tenant D1

来源:2026-07-26 迁移的最终整分支 review(含实测验证)。按阶段顺序执行,
每个 Phase 的门禁不满足就停。dev 已全量验证;本文只覆盖 prod。

> **执行状态(2026-07-27)**:Phase 0–3 已完成。
> - 事故记录:07-27 直接手动触发 Deploy Production,`migrate` 把 0008/0009 跑了,
>   `tenants.d1_database_id` 被清成 NULL;`migrate-tenant-dbs` 的零租户守卫拦下部署,
>   随后按 Phase 2 回退方案用存档 UPDATE 回填并验证(=Phase 2 以破坏+回填方式完成)。
> - Phase 1:旧表旁置为 `user/content/event_archive_20260727`;新 stream ID:
>   user `139c7a953bb84f968362e6060cd9370b` / content `2b06985ae6974312a4108c66be4d4ae4` /
>   event `c6ecee42c1c2467899a1c8990041ae26`(link/wrangler.toml 已同步,commit ebfda92);
>   sink `user_sink`/`content_sink`/`event_sink` 与三条 pipeline 已重建。
> - Phase 3:三库 `verified_type` 列 + `_tenant_migrations` 记 `0006-user-verified-type`,
>   t1 验证通过。
> - INTERNAL_SECRET bootstrap 已执行:五 worker 均有 `secret_text` 版本待 Phase 4 上线。
>
> **CUTOVER 完成(2026-07-27):Phase 4–7 全部执行完毕。**
> - Phase 4:首次触发在 sync-secrets 撞上 **10215**(bootstrap 版本未部署,经典
>   secrets-bulk 拒绝修改)——用 `wrangler versions deploy --version-id … --percentage 100`
>   把五个 rotation 版本 promote 上线后重跑,run 30246040895 全绿。此坑一次性:
>   此后"最新版本=已部署版本"恒成立。
> - INTERNAL_SECRET 二次轮换:值同时写入 GitHub Secret、五个 prod worker(普通
>   `secret put`,绑定已是 secret_text 无冲突)与本机 `~/.uniscrm-prod-internal-secret`
>   (600 权限,供本地运维调用 /internal 路由;泄露即在此文件)。
> - Phase 5(修正结论):cron 正常(整点 token 刷新可见);poller 自 07-21 静默是
>   **预期行为**——唯一 active 的 X channel 是系统 channel(is_byok=0,webhook 驱动,
>   poller 只轮询 BYOK),tenant 1 的 BYOK channel 07-22 已停用。D1 写路径与 dev
>   验证代码相同,组织性写入待真实 X 活动验证。
> - Phase 6:t1 355 user + 40 content、t100001 1 user 经 `/internal/backfill/pipeline`
>   回填(4 批全部 `{"ok":true}`);R2 核对 `COUNT(DISTINCT id)`:user **356**、
>   content **40**,与 D1 一致。t100000 空库跳过。
> - Phase 7:三库的 profile/segment_profiles/event/content_trigger_dedup 已删除;
>   三库现均只剩 `user`、`content`、`_tenant_migrations`(+ `_cf_KV`)。

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

**INTERNAL_SECRET 轮换(Phase 4 前必须,2026-07-27 代码侧已就绪)**:五个 worker
(web/admin/content/link/flow)的 prod 明文占位符 var 已从 wrangler.toml 删除,改由
GitHub Secrets 经 sync-secrets 下发(各模块 `.secrets.json` 已声明);守卫全部改为
fail-closed(secret 未定义一律 403,堵住 `undefined !== undefined` 的 fail-open)。
一次性 bootstrap(在本机手工执行一次;`wrangler secret put/bulk` 对已部署为明文 var
的同名绑定报 10053 冲突,只有 `versions secret put` 能原位转换,已在临时 worker 实测):

```bash
V=$(openssl rand -base64 32) && echo "$V" | gh secret set INTERNAL_SECRET --repo zcqqq/uniscrm-web \
  && for m in web admin content link flow; do \
       echo "$V" | wrangler versions secret put INTERNAL_SECRET --env production --config $m/wrangler.toml --message "rotate INTERNAL_SECRET"; \
     done; unset V
```

新版本不自动上线:线上继续用旧占位符直到 Phase 4 部署,部署时五个 worker 一起切换。
以后再轮换只需:更新 GitHub Secret → 触发 Deploy Production(secret_text 绑定可被
sync-secrets 的 bulk 直接覆盖,不再有 10053)。

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
INTERNAL_SECRET bootstrap(见 Phase 0)未执行前不要进行,否则 sync-secrets 会报
10053 冲突并卡住整条流水线。

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

## Phase 7 — cutover 之后的收尾删除

**租户库遗留表**(2026-07-26 已删 dev 侧;prod 侧因当前部署的旧代码仍在使用而延迟):
cutover(Phase 4 部署新代码)完成并验证后,对 `uniscrm-t1`/`uniscrm-t100000`/`uniscrm-t100001` 执行:

```bash
wrangler d1 execute <db> --remote --command \
  "DROP TABLE IF EXISTS profile; DROP TABLE IF EXISTS segment_profiles; DROP TABLE IF EXISTS event; DROP TABLE IF EXISTS content_trigger_dedup"
```

(`flow_counts`/`content_flow_counts` 的租户库死副本已于 2026-07-26 从全部四库删除——
真表在 FLOW_DB,新旧代码都不读租户库副本。)

`profile` worker 与 `uniscrm-maigret` 队列的删除另行决定。
**删除四个 uniscrm-t* 库:永久取消。**

## 附:2026-07-26 已执行的清理(记录)

- R2 dev 删除 10 张:user/content/event 的 `*_archive_20260722`、`user_v1`、`user_v2`、
  `content_v1`、`event_v1`、`flow_log_archive_20260723`、`content_flow_log_archive_20260723`、
  以及 ADR 0004 弃用的 `flow_node_log`(含孤儿 sink `flow_node_log_sink_dev`)。
- R2 prod 删除 4 张:三张 `*_archive_20260722` + `flow_node_log`。
- 两 warehouse 现各剩 5 张活表:user、content、event、flow_log、content_flow_log。
- dev 租户库(uniscrm-t1-dev)删除 6 张遗留表,现仅剩 user、content(+ _tenant_migrations 与
  D1 内部表)。
- 2026-07-27 cutover 验证后:prod 的 `user/content/event_archive_20260727` 三张旁置表
  已 purge 删除(1/0/8 行,user/content 已由 D1 回填取代)。两 warehouse 至此完全一致,
  各剩 5 张活表:user、content、event、flow_log、content_flow_log。

## 备用:list_users 旧 uuid 孤儿(当前两环境均为 0 行,无需执行)

若未来出现:`UPDATE list_users SET user_id = (SELECT es.source_id FROM entity_state es
WHERE es.entity='user' AND es.entity_id = list_users.user_id)` 可把 claim-uuid 归一到
source id 域,现有 resolver 即可解析。

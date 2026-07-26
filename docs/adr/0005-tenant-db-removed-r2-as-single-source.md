# Per-tenant D1 下线,R2 Data Catalog 成为唯一真相

> **2026-07-26 部分推翻**:本 ADR 描述的架构对 `user`/`content` 已被
> `docs/adr/0006-user-content-back-to-per-tenant-d1.md` 部分推翻——这两个可变实体的真相
> 回到了 per-tenant D1,R2 降级为分析副本。`event` 不受影响,本 ADR 记录的
> 「R2 是唯一真相」「不可变数据放 append-only 存储」对 `event` 依然成立。

每个租户一个 D1(`uniscrm-t*`)承载 `user`/`content`/`event`/`profile`/`segment_profiles`/
`content_trigger_dedup`,并且是通过 D1 REST API(而非 binding)访问的 —— 每次读写都是一次
跨网 HTTP。代价是:每开一个租户要建一个库、每次加列要遍历所有租户库跑 ALTER TABLE、
CI 里养着一个专门的 `migrate-tenant-dbs` job;同时 `user`/`content`/`event` 已经双写到
R2 Data Catalog,tenant D1 沦为会漂移的第二份真相。

现在 R2 SQL 补齐了 JOIN(2026-05)与窗口函数/QUALIFY(2026-06),读取时可以用
`QUALIFY ROW_NUMBER() OVER (PARTITION BY <业务键> ORDER BY updated_at DESC) = 1`
直接拿到每个业务键的最新行,正确性不再依赖 analytics 每日 02:00 的 compaction ——
compaction 因此降级为纯存储优化。于是把全部业务字段搬进 R2,per-tenant D1 全部删除。

R2 结构上做不到三件事:原子去重(append-only、无唯一索引)、变更检测(poller 每 tick
重走已抓过的页)、稳定 uuid 映射(点查 1-3s)。这三件事落在 `uniscrm-link` D1(binding
`LINK_DB`)的单张 `entity_state` 表上(`link/migrations/0008_entity_state.sql`)——
每行只有 key(`tenant_id`/`entity`/`channel_id`/`secondary_id`/`source_id`)+ 变更检测用的
`fingerprint` + 我们生成的稳定 `entity_id`,不含其它业务字段,355 个用户约 21 KB。
唯一的例外是 `is_follow`/`is_followed`:它们额外常驻在 `entity_state` 里,因为是 flow
`userPropsFilter` 的唯一热读,必须毫秒级;同时它们也写入 R2 的 `uniscrm.user` 表(供
analytics 作为 `isInsight` 维度读),由同一次调用写两处,不会漂移。原
`content_trigger_dedup` 并入为 `entity='content_trigger'`(`link/src/services/entity-state.ts`),
两套去重机制合成一套。

代价是明确接受的:**读路径全部变成 1-3s 的 R2 查询**。用户详情页因此整个删除
(而不是留一个慢页面,`link/frontend/pages/UserDetail.tsx`、`GET /api/users/:id`、
`GET /api/users/:id/events` 均已移除);Content 列表页的编辑改为「读整行 → 合并 →
整行回写」(`link/src/services/content.ts` 注释:「读整行 → 覆盖 → 整行回写。只发
{id, title} 会把其余列全部写成 null」)。写路径的铁律随之变成**只发完整行** ——
QUALIFY 取整行最新,部分写会把未包含的列变成 null。这条约束直接删掉了两个功能:
`content.status` 编辑(本来就没有任何读取方)和 flow 的 `changeUserProps` 节点
(Inspector 是自由文本框,后端裸拼 `UPDATE user SET ${field}`,既是注入面又只能改固定列)。

跨渠道 profile(maigret)一并删除:prod 上 `profile` 与 `segment_profiles` 都是 0 行。
后果是分群从「跨渠道的人」降级为「单渠道账号」,membership 改存 `uniscrm-web` 的
`segment_users`(`web/migrations/0007_segment_users.sql`),`insight-segment/src/services/
sql-builder.ts` 的查询目标改为 `uniscrm.user`(必要时 LEFT JOIN `uniscrm.event`)。

R2 三张表因为 sink schema 不可改而全部旁置重建,**历史数据不迁移** —— prod 当时只有
355 user / 40 content / 6 event。

最大的新风险:R2 从「分析用」变成产品主链路,`R2_CATALOG_TOKEN` 一挂整个产品白屏。
所有 R2 读路径因此必须抛错并返回 502,绝不静默返回空列表
(`shared/r2-sql.ts::r2Query` 区分「HTTP 200 但 body 里带 error」与真正的空结果)。

## 状态(写作时,2026-07-25)

Task 1–11 已实现并各自过审,但**尚无一次端到端验证**:账号的 R2 API token 当前返回
`80013 Unauthorized`,dev 部署、R2 三张表在 dev/prod 的旁置重建、浏览器自测均未跑过。
push to main、触发 prod 部署、以及删除四个 tenant D1(`uniscrm-t1`、`uniscrm-t100000`、
`uniscrm-t100001`、`uniscrm-t1-dev`)和已下线的 `profile` worker、`uniscrm-maigret`
队列,均在 token 修复、dev 全链路验证通过之后才能进行。

# Tenant DB 下线:R2 Data Catalog 成为唯一真相

**日期**:2026-07-25
**状态**:已确认,待实施

## 背景与驱动

每个租户一个 D1 数据库(`uniscrm-t1`、`uniscrm-t100000`、`uniscrm-t100001`、`uniscrm-t1-dev`),
承载 6 张表:`user`、`content`、`event`、`profile`、`segment_profiles`、`content_trigger_dedup`。
访问方式不是 D1 binding,而是 `shared/tenant-data-db.ts` 通过 Cloudflare D1 REST API
(`api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{id}/query`)发 HTTP —— 每次读写
都是一次跨网请求。

四个驱动(用户确认,全选):

1. **运维负担** —— `admin/services/tenant-provisioning.ts` 每来一个租户就建一个 D1;
   `operation/migrations/` 的每个迁移都要遍历所有租户库跑 `ALTER TABLE`;
   GitHub Action 有专门的 `migrate-tenant-dbs` job。租户一多就是灾难。
2. **数据冗余** —— `user`/`content`/`event` 已经双写到 R2 Data Catalog,tenant D1 成了第二份真相,
   两边会漂移。
3. **成本** —— 每租户一个 D1,大表吃存储和 rows_read。
4. **架构一致性** —— `uniscrm-web/CLAUDE.md` 已经写了「大数据存储基于 R2 data catalog」,
   tenant D1 是历史遗留。

实测数据量:prod `uniscrm-t1` 856 kB(`user` 355 行、`content` 40 行、`event` 6 行、
`profile` 0 行、`segment_profiles` 0 行、`content_trigger_dedup` 0 行);
`t100000`/`t100001` 各 127 kB。**体量不是瓶颈,驱动是运维与一致性。**

## 关键调查结论

这些事实决定了设计形态,记录在此以免后续重新推导。

### R2 SQL 今年已补齐关键能力

- **2026-05-14**:JOIN、子查询(IN/EXISTS/标量/派生表)、多表 CTE
- **2026-06-21**:窗口函数(`ROW_NUMBER` 等)、`QUALIFY`、`SELECT DISTINCT`、集合运算

因此可以在读取时用 `QUALIFY ROW_NUMBER() OVER (PARTITION BY ... ORDER BY updated_at DESC) = 1`
拿到每个业务键的最新行,**不再依赖每日 02:00 的 compaction 正确性**。

⚠️ 窗口函数是 budget-gated:R2 SQL 会预估扫描量,过大直接返回 400。所有查询必须带
`WHERE tenant_id = ?`。

### `is_follow` / `is_followed` 在 R2 里现在是错的

`analytics/pipelines/user-stream-schema.json` 有这三列(含 `is_active`),但写入路径是断的:

- `x-users.ts::setFollowState()`(webhook 收到 follow/unfollow 时调用)**只写 D1,不发 pipeline**
- `x-users.ts::upsertUser()` 发 pipeline 时**硬编码 `is_follow: 0, is_followed: 0`**
- `x-users.ts::upsertUserFromMetadata()`(poller 路径)**根本不带这三列**
- `x-users.ts::setUserActive()` 是**死代码**,全仓无调用点

而 `link/src/routes-users.ts` 的 Users 列表页**已经在读 R2 的 `is_follow`/`is_followed`** ——
今天列表页显示的关注状态全是 0。这是现存的数据准确性 bug,本次一并修复。

好消息:`link/src/webhook.ts` 调 `setFollowState` 的**前一行**就是 `upsertUser(userData, ...)`,
完整 user 对象本来就在手里,合并成一次整行 upsert 即可,**无需引入列级合并 compaction**。

### compaction 是整行取最新,不做列合并

`analytics/compactor/main.py` 按 `(tenant_id, channel_id, source_user_id)` 分组、
按 `updated_at` 降序取第一行、整表 `overwrite`。所以**任何"只更新一列"的写法都会把其它列抹成 null**。
这直接推导出下面「写路径铁律:只发完整行」。

### `content.status` 没有任何读取方

- 前端 `ContentTable` 只编辑 title + summary,从不发 status
- `VALID_STATUSES = ["new","pending","published","ignored"]` 只在 PATCH 里校验
- 唯一真实写入是 `webhook.ts` 推文被删时 `status='deleted'`,同样没人读

### flow 的 user props 热读只有 `is_follow`

- `userPropsFilter`(xAction 前置过滤)只用到 `is_follow`(`metadata/x.ts:154,166`)
- `userPropsCondition` 节点在 `executeActions` 里**没有 handler**,是已知的 dead branch
- `changeUserProps` 节点的 Inspector 是两个自由文本框,后端裸拼
  `UPDATE user SET ${u.field} = ?` —— 没有白名单、没有 metadata 下拉、没有自定义属性存储,
  只能改 `user` 表上已存在的固定列,且是 **SQL 注入面**

### `profile` 模块实际未使用

prod `profile` 表 0 行、`segment_profiles` 0 行;`profile` worker 只有
`/health`、`/internal/maigret-retry`、`/api/auth/me`、`/api/users`;
`profile.uni-scrm.com` 不在任何 nav 里。`flow/src/index.ts` 那句
「Proxy lists from profile worker」注释是过时的 —— 实际转发到 `link`。

## 一、数据归属

### R2 Data Catalog(唯一真相,3 张表全部重建)

Pipeline sink 的 schema 不可修改,且拒绝写入已存在的 Iceberg 表。所以机制是:
**把现表重命名旁置**(`user` → `user_v1`,仅为腾出表名,旁置副本不再被读)→
新建 stream/sink/pipeline → 新表从零开始。**历史数据不迁移**(用户确认)。

| 表 | schema 变更 |
|---|---|
| `uniscrm.user` | ＋`raw_data` (string)、＋`is_deleted` (int32);－`profile_id` |
| `uniscrm.content` | ＋`title` `content_text` `summary` `source_url` `source_updated_at` `list_id` `cover_image_url` `duration` `height` `width` `has_face` `view_count` `share_count`、＋`raw_data`、＋`is_deleted`;－`status` |
| `uniscrm.event` | ＋`raw_data` |

`raw_data` 的语义:**payload 中没有映射到具名列的剩余字段**,不是全量 payload。
既保留未知字段以备后续加列,又不违反 `CLAUDE.md`「调用外部 API 返回的 payload 全量数据
不要存在数据库中」。

`is_deleted` 为 int32,`0` = 存在、`1` = 已删除,所有读路径带 `AND is_deleted = 0`。

### D1 `uniscrm-link`(binding `LINK_DB`)—— 新增 1 张表

```sql
CREATE TABLE entity_state (
  tenant_id    INTEGER NOT NULL,
  entity       TEXT NOT NULL,               -- 'user' | 'content' | 'content_trigger'
  channel_id   TEXT NOT NULL,
  secondary_id TEXT NOT NULL DEFAULT '',    -- list_id / subscriptionChannelId,无则空串
  source_id    TEXT NOT NULL,               -- source_user_id / source_content_id
  entity_id    TEXT NOT NULL,               -- 我们生成的 uuid,跨多次写入稳定
  fingerprint  TEXT,                        -- 变更检测
  is_follow    INTEGER,
  is_followed  INTEGER,
  seen_at      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity, channel_id, secondary_id, source_id)
);
CREATE INDEX idx_entity_state_entity_id ON entity_state(tenant_id, entity_id);
```

**它不是数据副本,是索引。** R2 Data Catalog 结构上做不到、而写路径每次都要做的三件事:

| 业务问题 | R2 为什么给不了 | `entity_state` 里的字段 |
|---|---|---|
| 「这条内容/这个用户我见过吗?」决定 flow trigger 要不要触发 | append-only,没有唯一索引、没有原子 `INSERT OR IGNORE`;并发写入者会重复触发 flow | PK + `seen_at` |
| 「它变了吗?」 | X followers poller 每 tick 重走已抓过的页,没有这个判断会全量重发,表按天万行膨胀 | `fingerprint` |
| 「它在我们系统里的 id 是什么?」 | `content.id`/`user.id` 是我们生成的 uuid,flow log / vectorize / pending 队列都引用它;R2 点查 1–3s,poller 一批几十条直接超时 | `entity_id` |

`is_follow`/`is_followed` 额外常驻此处,因为它们是 flow `userPropsFilter` 的唯一热读,
必须毫秒级。它们同时写入 R2(analytics 需要作为 `isInsight` 维度),
**单一写入者、同一次调用内写两处**,不会漂移。

原 `content_trigger_dedup` 并入为 `entity='content_trigger'`(只用到 PK + `seen_at`),
两套去重机制合成一套。

每行约 60 字节,355 个用户约 21 KB。

### D1 `uniscrm-web`(binding `WEB_DB`)

```sql
CREATE TABLE segment_users (
  tenant_id  INTEGER NOT NULL,
  segment_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (segment_id, user_id)
);
CREATE INDEX idx_segment_users_tenant ON segment_users(tenant_id);
```

取代 tenant DB 的 `segment_profiles`。`segments` 表本来就在 `uniscrm-web`。
**分群键从 profile 降级为 user** —— 从「跨渠道的人」变成「单渠道账号」,
这是删除 profile 功能的直接后果,用户已确认接受。

## 二、删除清单

| 类别 | 内容 |
|---|---|
| **功能** | 用户详情页(`link/frontend/pages/UserDetail.tsx`、`GET /api/users/:id`、`GET /api/users/:id/events`、Users 列表页的跳转);`content.status` 编辑(PATCH 的 status 分支 + `VALID_STATUSES`);flow `changeUserProps` 节点;跨渠道 profile(maigret) |
| **Worker** | 整个 `profile` 模块(目录、wrangler.toml、CI 矩阵条目、`profile.uni-scrm.com` / `profile-dev.uni-scrm.com` 路由) |
| **代码** | `shared/tenant-data-db.ts`;`admin/src/services/tenant-init-sql.ts`;`admin/src/services/tenant-provisioning.ts` 中的建库逻辑;`operation/migrations/` 全部 5 个;`x-users.ts::setUserActive`(死代码);各模块 `Env` 里的 `CF_D1_API_TOKEN`(仅在无其它用途时) |
| **CI** | `.github/workflows/deploy-prod.yml` 的 `migrate-tenant-dbs` job;deploy 矩阵移除 `profile` |
| **Cloudflare 资源** | `uniscrm-t1`、`uniscrm-t100000`、`uniscrm-t100001`、`uniscrm-t1-dev` —— **最后一步**,dev + prod 均确认无回归后再删 |

## 三、读路径

新增 `shared/r2-sql.ts`,统一封装 R2 SQL 的 HTTP 调用
(`https://api.sql.cloudflarestorage.com/api/v1/accounts/{acct}/r2-sql/query/{bucket}`)。
现在 `link/src/routes-users.ts` 和 `flow/src/index.ts` 各手写了一份,合并为一处。
该模块必须:

- 强制 `tenant_id` 参数,不接受无租户过滤的查询(budget gate + 租户隔离)
- 区分「查询失败」与「结果为空」,失败时抛出而非返回 `[]`
  (`project_event_stream_schema_rebuild` 记录过 R2 SQL 出错仍 exit 0 的坑)

所有实体读统一形态:

```sql
SELECT <cols> FROM uniscrm.user
WHERE tenant_id = ? AND is_deleted = 0
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY channel_id, source_user_id ORDER BY updated_at DESC
) = 1
```

`content` 的 PARTITION BY 为 `channel_id, list_id, source_content_id`
(`list_id` 为 NULL 时自成一组,与 D1 那两个 partial unique index 的语义一致)。
`analytics/src/index.ts::compactContentTable` 传给 compactor 的 `key_columns`
要同步补上 `list_id`,否则 compaction 会把同一 `source_content_id` 在不同 list 下的行错误合并。

这样读到的永远是最新行,compaction 降级为纯存储优化(保留每日一次即可,
不再承担正确性职责)。副作用:同时修掉今天 Users 列表页在两次 compaction 之间
显示重复行的问题。

## 四、写路径铁律:只发完整行

读路径用 `QUALIFY` 取整行最新,因此**任何部分写都会把其它列变成 null**。

| 场景 | 现在 | 改为 |
|---|---|---|
| webhook follow/unfollow | `upsertUser()` 后紧接 `setFollowState()` 两次写 | 合并成一次带 `is_follow`/`is_followed` 的整行 upsert(完整 `userData` 本来就在手里),同一调用内更新 `entity_state` |
| poller 增量抓取 | `SELECT` 旧行逐列比对得出 `unchanged` | 查 `entity_state.fingerprint` 比对;未变则不发 R2,只更新 `seen_at` |
| content 编辑 title/summary | `UPDATE content SET ...` | 先读一次 R2 拿整行 → 合并改动 → 整行回写(人工保存操作,1–3s 可接受) |
| content 删除 | `DELETE FROM content` | 整行回写 `is_deleted = 1` |
| 推文被删(webhook) | `UPDATE content SET status='deleted'` | 整行回写 `is_deleted = 1` |
| 新建实体 | `INSERT ... ON CONFLICT DO UPDATE` 拿 uuid | 先 `INSERT OR IGNORE INTO entity_state` 取得/复用 `entity_id`,再整行发 R2 |

`fingerprint` 的计算:对参与变更检测的字段按固定顺序拼接后取哈希。
`user` 取 `name|username|profile_image_url` + 所有 `isInsight` prop;
`content` 取 `source_updated_at` + `title|summary|source_url`。

## 五、上线顺序

dev 全程用本地 `wrangler deploy --env dev`(**必须带 `--env dev`**,裸 `deploy` 会打到 prod
并抹掉 bindings);prod 走手动触发的 GitHub Action。

1. `entity_state` / `segment_users` 迁移 + `shared/r2-sql.ts`
2. R2 三张表旁置重建(dev 先行:验证写入、`QUALIFY` 读取、`raw_data` 落盘)
3. `link` 切换:整行写 R2 + 写 `entity_state`;所有读改 R2;删用户详情页、删 `status`
4. `flow` 切换:增加 `LINK_DB` binding,`is_follow` 读 `entity_state`;删 `changeUserProps`;
   node log 的用户名查询改 R2
5. `insight-segment` 切换:`sql-builder.ts` 目标改 `uniscrm.user` / `uniscrm.event`,
   membership 写 `segment_users`
6. 删除 `profile` worker、`TenantDataDB`、`admin` 建库逻辑、`operation/migrations`、CI job
7. dev 端到端自测通过 → prod 部署 → **最后**删 4 个 tenant D1

第 7 步之前 tenant DB 全程保留不删,任一步出问题可回滚到读写 tenant DB 的版本。

## 六、测试

按 `uniscrm-web/CLAUDE.md` 的 coding agent 规则,每步实现完立即自测 + 补/改 test case。

- `link/tests/`:`entity_state` 去重(重复 source_id 只算一次新)、变更检测(fingerprint 相同不发 R2)、
  并发 `INSERT OR IGNORE` 只有一个赢家、整行写入不丢列、逻辑删除后读不到
- `flow/tests/`:`is_follow` 从 `entity_state` 读取、`userPropsFilter` 通过/拦截、
  `changeUserProps` 移除后旧 graph 不崩
- `insight-segment/tests/`:SQL 生成器输出 `uniscrm.*` 目标表且带 `tenant_id`、
  membership 写入 `segment_users`
- `shared/`:R2 SQL 客户端在错误响应时抛出而非返回空
- `scripts/tenant-scope-audit.mjs`:扩展覆盖 `entity_state` / `segment_users`
- dev 上跑真实 X poller + webhook 端到端(`link-dev` + `flow-dev`)

## 七、前置阻塞项

`analytics-dev` 当前报 **`80011: Unauthenticated`**(R2 SQL token 失效)。
本方案之后 R2 从「分析用」变成**产品主链路**,token 一挂整个产品白屏。上线前必须:

1. 修复 dev/prod 的 `R2_SQL_TOKEN`
2. 所有 R2 读路径给出明确错误态(HTTP 5xx + 前端错误提示),
   不得静默返回空列表 —— 「数据准确性 > 系统稳定性 > 功能 > UI 界面」

## 八、需要更新的文档

- `uniscrm-web/CLAUDE.md`:删掉「比较特殊的是 tenantdb,各个模块可能都有数据量大的表,
  要按租户分库放到 tenantdb」;模块列表移除 `profile`
- 新增 ADR:`docs/adr/0005-tenant-db-removed-r2-as-single-source.md`,
  记录「per-tenant D1 → R2 单一真相 + D1 索引层」的决策与取舍
- `docs/adr/0002`(compaction 去重):补记 compaction 不再承担读正确性

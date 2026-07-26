# User/Content 回 per-tenant D1,R2 降级为分析副本

**日期**:2026-07-26
**状态**:已确认,待实施
**关系**:部分推翻 `2026-07-25-tenant-db-removal-design.md`。那次迁移把 user/content/event
的唯一真相全部搬进 R2 Data Catalog;本设计把 **user 和 content 的真相挪回 per-tenant D1**,
R2 副本只服务 analytics/insight-segment。event 不动(R2 唯一真相)。

## 为什么推翻

R2 Data Catalog 是 append-only。对**频繁更新**的实体,这次 dev 验证暴露了完整代价链:

- 每次字段变化 append 一行,读取靠 `QUALIFY ROW_NUMBER()` 取最新,存储靠 compaction 收敛;
- webhook 只知道部分字段,写前必须**读回 R2 整行再合并**(1–3s),否则把 poller 写的指标列冲成 null;
- 变更检测要靠 `entity_state` 指纹,两个写入方必须对同一字段清单算指纹,发送失败还要回滚指纹;
- 给 user 表加两列(`profile_image_url`/`description`)触发了**全量 357 用户重发**,
  因为指纹字段清单就是完整性契约的一部分。

这些复杂度对不可变的 event 全部不存在——append-only 对它是天然契合。
结论(用户判断,本设计执行):**可变实体放可变存储,不可变实体放 append-only 存储。**

## 用户拍板的三个决定

1. user/content 回 **per-tenant D1**(恢复原有 uniscrm-t* 库,不是共享 D1 + tenant_id)。
2. R2 **保留 user + content 的分析副本**(双写)。决定性理由:R2 SQL 只能查 R2 内的表,
   user 若完全退出 R2,`event JOIN user`(insight-segment 的事件条件分群、analytics 按
   用户属性切 event)在 SQL 层就不可能,只能应用层两步 join 或把属性冗余进 event 行。
3. **flowType 门控**:只有 metadata 中 `flowType: "content"` 的内容源才落 content 表
   (D1 与 R2 副本一致);其余只在 flow 中处理,不落任何库。

## flowType 现状盘点(代码事实)

| flowType | 条目 | 语义 | 落库? |
|---|---|---|---|
| `content` | X `own:get-posts`、TikTok `video.list` | 自己的内容(内容库) | ✅ D1 + R2 |
| `trigger` | X `get-list-posts`、YouTube `watch:get-videos` | 别人的内容,喂 flow | ❌ 只发 flow 事件 + `entity_state` 去重 |
| `action` | 发帖/点赞/收藏等 | 动作,非内容源 | 不适用 |

Task 7 已确认两个 trigger poller(x-list-posts、youtube-content)**事实上本来就不落库**;
本设计把"碰巧如此"升级为 `ContentService` 里 metadata 驱动的显式门控。
**假设(已声明)**:LOCAL/NOTION 的 `syncBatch` 导入不走 ContentMetadata,属于自有内容库,照常落库。
webhook 的 `post.create`(自己发的推文)属于 own 内容,照常落库。

## 一、数据归属(最终形态)

| 数据 | 真相 | 副本 | 说明 |
|---|---|---|---|
| `user` | per-tenant D1 | R2 `uniscrm.user`(analytics 专用) | UPDATE 原地改 |
| `content`(仅 flowType:content + 本地导入) | per-tenant D1 | R2 `uniscrm.content`(同口径) | 编辑/删除走 D1 |
| trigger 内容 | 不落库 | 无 | `entity_state` `entity='content_trigger'` 去重 |
| `event` | R2(不变) | 无 | 不可变 |
| `entity_state`(LINK_DB) | 保留 | — | 两职责:trigger 去重、flow 热读 `is_follow`/`is_followed` |
| `segment_users`(WEB_DB) | 保留 | — | 分群 membership,不变 |

**id 域纪律**(上轮 final review 的 2 个 Critical 都源于此,必须写死):
D1 `user.id` = R2 副本 `id` = `entity_state.entity_id`,三处同一个 uuid,由 D1 表铸造;
`event.user_id`、flow 的 `userId`、`list_users.user_id`(flow 写入的)始终是**平台源 id**(X 数字 id)。
凡是拿平台 id 查 uuid 域的地方必须经 `source_user_id` 列。

## 二、per-tenant D1 复活清单

全部可从 commit `371d0c5`(Task 11 的删除)恢复后改造:

| 项 | 处理 |
|---|---|
| `shared/tenant-data-db.ts` | 恢复原样(REST 客户端) |
| `admin/src/services/tenant-init-sql.ts` | 恢复并**重写 schema**:只有 `user` + `content` 两张表。user 无 `profile_id`、用 `post_count`(不是 tweet_count);content 无 `status`。无 profile/segment_profiles/event/content_trigger_dedup 表 |
| `admin` 建库 provisioning(含 `provision-db` task 类型) | 恢复;signup 流程 = tenants 行 + provision-db task + activate-trial task |
| `.github/workflows` `migrate-tenant-dbs` job | 恢复(dev + prod 两个 workflow) |
| `link` 的 `CF_D1_API_TOKEN` | Env/types + `.secrets.json` 恢复声明。⚠️ 两个 workflow 的 sync-secrets env 已不再导出它(grep 证实),必须**先**把 `CF_D1_API_TOKEN: ${{ secrets.CF_D1_API_TOKEN }}` 加回两个 workflow,否则 `scripts/secrets-sync.test.mjs` 守卫红(R2_SQL_TOKEN 同款陷阱)。GitHub 仓库 secret 大概率还在,实施时验证 |
| `webhook.ts`/`poll-channel.ts` 的 `d1DatabaseId` 查询与"未开通跳过"守卫 | 恢复。dev 的 8 个租户只有 t1 有库,其余是 e2e 测试租户——守卫是日常路径不是边角 |
| `flow` | **不恢复** REST 客户端/CF_D1_API_TOKEN。继续从 `entity_state`(LINK_DB binding)读 `is_follow` |

**`tenants.d1_database_id` 列**(0008 只应用到了 dev,prod 从未跑过 0007/0008):
保留 0008 文件不动,新增 0009 重新 `ADD COLUMN d1_database_id TEXT`(两环境都会跑:dev 立即,
prod 在其迁移序列里先 drop 后 add)。**回填不进 migration**(两环境 id 不同,SQL 无法分支),
用逐环境 `wrangler d1 execute` 完成,id 已知并在此存档:

- dev:tenant 1 → `e2a547ee-94eb-48e0-b3cc-18f882d33c07`(uniscrm-t1-dev)
- prod:1 → `f5f49e47-d779-49a0-b609-f2b2ab5fd09f`(uniscrm-t1);
  100000 → `ce377715-5196-4ad7-b2d7-a52a75a734d6`;100001 → `b8656ee3-3e93-4d8c-b782-0508a824d549`

prod 部署 runbook:migrations apply 后**立即**执行回填,窗口内 /trend-update 等读方不受影响
(该路由已改为不过滤此列)。

四个 uniscrm-t* 库的数据都在(约滞后一天)。「最后删库」步骤**取消**。

## 三、写路径(link)

D1 为主写,恢复迁移前模式:`INSERT ... ON CONFLICT DO UPDATE` upsert,
先 SELECT 现有行比对得出 `unchanged`(替代 entity_state 指纹)。
`unchanged` 时跳过 R2 双写——R2 副本沿用**这轮修硬的整行构造器**
(`buildUserRecord`/`buildContentRecord`:完整行、真实 is_follow、consumedPaths 按 dataId 剥
raw_data、schema key 集合对齐测试全部保留)。

**拆除的 R2-era 机制**(仅 user/content 路径):
- `upsertUser` 的读回 R2 合并(`getUserBySource` 读路径保留给别处,合并源改为 D1 行);
- `entity_state` 对 user/content 的指纹/`claim` 铸 id/`rollbackFingerprint`(D1 唯一索引 + SELECT 比对覆盖);
- user/content 的 `is_deleted` 逻辑删除改回 D1 硬删除 + 给 R2 副本发 `is_deleted=1` 墓碑行
  (analytics 读路径的 `outerWhere is_deleted=0` 不变);
- compaction 恢复为纯存储优化(本来就已降级,不变)。

**entity_state 写入方**:link 写 user 时同步维护 follow 两列
(`INSERT OR IGNORE` + `UPDATE`,`entity_id` 填 D1 行的 id,保持单一 id 域);
trigger 内容继续 `markSeen`。

**flowType 门控落点**:`ContentService.upsertContentFromMetadata` 增加 metadata 查询
(按 channelType + sourceContentType 找到条目的 flowType),`trigger` → 只 `markSeen` + 发
flow 事件;`content` → D1 upsert + R2 双写 + flow 事件。门控逻辑必须 metadata 驱动,
不允许按 poller 名字硬编码。

## 四、读路径

| 读方 | 改动 |
|---|---|
| Content Library 路由(list/get/patch/delete) | **改回 D1**(快、可编辑;delete = D1 硬删 + R2 墓碑 + vectorize 删除) |
| Users 列表页 | 不动(迁移前就读 R2,现在数据正确) |
| lists 成员名、flow node-log 用户名 | 不动(读 R2) |
| insight-segment 分群 SQL | 不动(R2,QUALIFY+JOIN 已验证) |
| analytics 全部 | 不动 |
| flow `userPropsFilter` | 不动(entity_state) |

## 五、迁移与验证

- 数据回填:不需要脚本。followers/posts poller 增量重走自动补齐 D1(滞后一天的量);
  content 量个位数。
- R2 副本:dev 三张表已是新 schema,继续用;prod 三张表仍需按
  `analytics/pipelines/rebuild-tables.md` 重建(仍在冻结清单,随本设计一起解冻实施)。
- 测试:恢复/改造的每条写路径保留 schema key 集合断言;flowType 门控要有
  "trigger 源不落 D1 不发 R2、content 源两者都发"的正反测试;
  tenant 未开通守卫要有测试;`tenant-scope-audit` 继续全绿。
- dev 端到端:signup(可用 e2e 租户)→ provision → poller 落 D1 → Users/Content 页 →
  编辑/删除 → analytics 报表仍出数 → 分群含事件条件仍可算。

## 六、上轮迁移资产的保留/回退清单

**保留**:`shared/r2-sql.ts`、event R2 唯一真相、R2 写路径加固(整行/is_follow/raw_data 剥离/
schema 测试)、`entity_state`、flow LINK_DB binding、insight-segment 与 analytics 全套、
profile 模块删除、changeUserProps 删除、content.status 删除、用户详情页删除、
`R2_CATALOG_TOKEN` 合并、node-id 校验、`segment_users`。

**回退**:user/content 真相位置(R2→D1)、TenantDataDB/provisioning/CI job/d1_database_id、
content 路由数据源(R2→D1)、读回合并与指纹机制(拆除)、「删除 4 个 tenant D1」计划(取消)。

**文档随动**:ADR 0005 追加"部分推翻"注记并新增 ADR 0006 记录本决定;
`uniscrm-web/CLAUDE.md` Technical 段的存储规则改写(user/content 真相在 per-tenant D1,
R2 为分析副本,event 仍 R2 唯一)。

# User/content 真相回迁 per-tenant D1,R2 降级为分析副本

`docs/adr/0005-tenant-db-removed-r2-as-single-source.md` 把 `user`/`content`/`event` 的唯一真相
全部搬进了 R2 Data Catalog,per-tenant D1(`uniscrm-t*`)全部下线。上线后一天的 dev 实际运行,
把 append-only 存储对**频繁更新实体**的完整代价链暴露了个遍:webhook 每次只知道被改动的那几个
字段,写之前必须先把 R2 里的整行读回来再合并,单次 1-3s;变更检测靠 `entity_state` 的
`fingerprint`,两个独立写入方(webhook、poller)要对同一份字段清单算出一致的指纹,发送失败
还要把指纹回滚,机制本身比它要解决的问题更复杂;给 `user` 表加 `profile_image_url` 和
`description` 两列,直接触发了全量 357 个用户的重发,因为指纹字段清单本来就是数据完整性契约的
一部分,加列即改约定;而这一切之所以成立,前提是读路径靠 `QUALIFY ROW_NUMBER()` 取最新行、
存储层靠每日 compaction 把重复行收敛掉——compaction 从「读正确性依赖」降级为「纯存储优化」只是
2026-06 QUALIFY 上线之后的事,在此之前它一直是正确性链条里不能缺的一环,append-only 架构从
根子上就是为不可变数据设计的,套在会被反复改字段的实体上,复杂度是必然,不是实现疏忽。
这些代价对不可变的 `event` 全部不成立——event 天然是一次写入、永不更新,append-only 正是它的
理想形态。结论(用户判断,本设计执行):**可变实体放可变存储,不可变实体放 append-only 存储**。

## 用户拍板的三个决定

**user/content 的真相回到 per-tenant D1**,而不是共享 D1 加 `tenant_id` 列——沿用 0005 之前
就有的 `uniscrm-t*` 库结构,每租户一库,经 `shared/tenant-data-db.ts` 的 REST 客户端访问(非
binding,跨网 HTTP)。**R2 保留 user/content 的分析副本**(双写),这不是过渡期的将就,而是
结构性必需:R2 SQL 只能查 R2 内部的表,做不到跨存储 JOIN,`event JOIN user` 这类查询——
insight-segment 按事件条件分群、analytics 按用户属性切 event——一旦 user 完全撤出 R2,
在 SQL 层就再也做不到,只能退化成应用层两次查询拼接,或者把用户属性冗余进每一行 event,
两条路都比维护一份分析副本更差。**flowType 门控**:只有 metadata 里标注 `flowType: "content"`
的内容源(如 X 的 `own:get-posts`、TikTok 的 `video.list`,即「自己的内容」)才落 content 表
(D1 + R2 副本同步写);标 `trigger` 的内容源(如 X 的 `get-list-posts`、YouTube 的
`watch:get-videos`,即「别人的内容,喂 flow 用」)只发 flow 事件,靠 `entity_state`
(`entity='content_trigger'`)去重,不落任何库。这条门控是 metadata 驱动的显式判断,不是按
poller 名字硬编码。

## 实现过程验证/暴露的东西

**id 域纪律**:D1 的 `RETURNING id` 是唯一权威 id 来源,下游(R2 副本发送、flow 事件、
`entity_state` 镜像)必须使用这个返回值,不能自己另外 mint。最初的实现用「探测是否存在
→ 没有就自己生成 uuid → upsert」三步走,三步之间不是原子的:webhook 和 poller 并发命中同一个
key 时,会出现 D1 里落地的是 A 的 id,而下游发出去的 R2/flow 事件却带着另一个探测阶段 mint 出的
幽灵 id B。修复是把 INSERT 语句本身加 `RETURNING id`,下游一律用这一次数据库调用返回的 id,
彻底取消探测阶段的预生成。**`unchanged` 跳过与 R2 副本的回填陷阱**:为了避免没有实际变化的行
也重复发送 R2(那正是要甩掉的 append-only 代价),写路径在检测到某一行与 D1 现有值完全一致时
会跳过 R2 发送。这个优化的副作用是:一行如果从被创建起就从未被真正改过,它永远不会被判定为
「变了」,也就永远到不了 R2——poller 的增量重跑不会自动补上这个缺口(它本来就是设计给
`unchanged` 场景省流量的)。这在 dev 环境里量化为可观的缺口(user 267/410、content 43/442,
Users 列表页因此少列了大约三分之一的人)。永久性的补救不是「等 poller 再跑一遍」,而是新增的
`POST /internal/backfill/pipeline` 路由:按表名白名单、200 条/批上限,直接把 D1 全量行经
worker 自己持有的 pipeline binding 重放进 R2 stream 一次;dev 环境已用它把 R2 两表分别补到
411 与 484 条,与 D1 对齐。`entity_state` 在这次回迁后只剩两个职责:trigger 内容去重
(`markSeen`,`entity='content_trigger'` 的原子 `INSERT OR IGNORE`)和 follow 位镜像
(`ensureEntity`/`setFollow` 维护 `is_follow`/`is_followed`,供 flow 的 `userPropsFilter`
毫秒级热读);「变了吗」这条判断(`fingerprint` 变更检测、`claim()` 自行铸造 uuid、
`rollbackFingerprint()`)随本设计整体删除,`fingerprint` 列留在表结构里未迁移删除,但代码
不再写它——判断「变了吗」现在是 D1 侧一次 SELECT 比对,而不是跨系统维护一份指纹。

## 从 0005 的世界里留下的东西

`event` 仍然是 R2 唯一真相,不受这次回迁影响——它是不可变数据,append-only 正是它该待的地方。
`shared/r2-sql.ts` 保留,读 R2(event、user/content 分析副本、insight-segment、analytics)一律
经过它,必须带 `tenant_id` 过滤并用 QUALIFY 取每个业务键的最新行。0005 那一轮为写路径加固的
东西全部留用:`buildUserRecord`/`buildContentRecord` 整行构造器(部分写会把未包含的列写成
null,这条约束没有变,只是现在的「整行」来源从「读回 R2 合并」换成了「D1 是权威源,直接照抄」)、
真实 `is_follow`/`is_followed` 值、`consumedPaths` 按 metadata `dataId` 剥离 `raw_data` 的逻辑、
schema key 集合的对齐测试。insight-segment 的分群 SQL 和 analytics 全套报表不动,继续读 R2。
0005 那一轮做的功能删除(profile/maigret 跨渠道身份、flow 的 `changeUserProps` 节点、
`content.status` 编辑、用户详情页)都维持删除状态,这次回迁没有把它们带回来。

## 接受的代价

D1 经 REST(而不是 binding)访问的跨网延迟重新出现,这是 0005 想省掉、现在又主动换回来的成本。
per-tenant 的开库与迁移随之复活:admin 的 signup 流程重新在开租户时跑 `provision-db` 任务,
CI 里的 `migrate-tenant-dbs` job(dev/prod 各一个 workflow)重新常驻,给 user/content 加列要
遍历所有租户库。`tenants.d1_database_id` 列(此前的 0008 迁移只在 dev 跑过,prod 从未应用)
用新的 0009 迁移重新补上,三个 prod 租户库的 id 已在实施过程中查明并存档,回填走逐环境的
`wrangler d1 execute`,不进 migration 文件(dev/prod 的 id 不同,SQL 没法分支)。R2 副本的发送
失败走「记日志、不阻塞主写入」的策略——D1 才是真相,一次 R2 发送失败不该让整个写请求失败;
代价是副本会有暂时性缺口,靠该行下一次真正的变更自然愈合,或者靠 `/internal/backfill/pipeline`
一次性补齐历史缺口,而不是靠重试或事务保证一致。

## 状态(写作时,2026-07-26)

Task 1–9b 已实现、逐个过审并在 dev 端到端验证:signup → provision → poller 落 D1 → Users/
Content 页 → R2 副本回填 → analytics/insight-segment 仍出数,全部跑通。prod 侧仍是空白:
R2 三张表的旁置重建、prod 的 migrations 0007/0008/0009 连跑与 `d1_database_id` 三条回填、
prod 部署、`profile` worker 与 `uniscrm-maigret` 队列的删除,都还在冻结区,留给上线 runbook。
「删除四个 `uniscrm-t*` 库」这一步(0005 遗留的收尾计划)永久取消。

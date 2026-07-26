# Business
数据准确性 > 系统稳定性 > 功能 > UI界面
永远不要为了兼容脏数据而增加复杂功能，或者为了不合适的功能改UI。

# Code
uniscrm-web库是多租户SaaS，分多个模块/worker：
- admin: 租户管理，billing。
- content: 租户BYOK LLM key管理 + 内置skill配方 + 内容生成(/internal/generate)，供flow的aiRewritePublish action调用。
- flow: 基于reactflow的事件触发工作流。
- analytics: 多种SQL即席分析、和可视化报表。
- insight-segment: 基于user（单渠道账号）的SQL规则分群，membership存WEB_DB的segment_users。
- link: 统一渠道模块。social/content/commerce/lists统一在一个Worker中。
- metadata: event/user/flow等实体基于元数据配置。
- operation: 生产环境运维相关，可以存储一些修复数据的临时脚本。
- shared: 不是模块/worker。包含UI组件等所有模块通用的组件。
- web: 登录页及通用功能如设置等。

git分dev和main分支，提交到main分支时自动通过github部署dev环境（cloudflare资源加-dev后缀），cloudflare上prodution环境部署由github action手动触发。

前端不用inline CSS，全部组件化。

# Technical
大数据存储基于R2 data catalog.
各模块间尽量减少逻辑耦合，通过数据（Cloudflare各组件）耦合。所以在Cloudflare组件的配置文件中，尽量用模块名做前后缀，如DB_WEB，而不是通用的DB、以减少各个模块间的歧义。
user/content 的真相在 per-tenant D1（uniscrm-t*，经 shared/tenant-data-db.ts 的 REST 客户端
访问，非 binding；开库靠 admin 的 provision-db 任务，加列靠 CI 的 migrate-tenant-dbs job）。
R2 保留 user/content 的 analytics 副本（双写，unchanged 时跳过发送；副本历史缺口靠
POST /internal/backfill/pipeline 一次性回填，poller 增量重跑不会自动补）。event 仍是 R2
唯一真相，不变。只有 metadata 里 flowType: "content" 的内容源才落库（D1 + R2 副本同步写）；
trigger 内容只进 flow，靠 entity_state 去重，不落任何库。读 R2 一律经 shared/r2-sql.ts，
必须带 tenant_id 过滤并用 QUALIFY 取每个业务键的最新行。见 docs/adr/0006（user/content）与
docs/adr/0005（event）。
UI：所有icons都要加上tooltip文字便于区分。

## 外部公开子仓库依赖
`link` 模块的 BYOK 凭证加密逻辑（`src/services/crypto.ts`）依赖独立公开仓库
`uniscrm-byok`（https://github.com/zcqqq/uniscrm-byok ，本地路径与 uniscrm-web
同级：`../uniscrm-byok`），目的是让客户可独立审计加密实现。
`link/package.json` 通过 `"uniscrm-byok": "github:zcqqq/uniscrm-byok#v1.0.0"`
锁定 tag 依赖（非分支）。

**改动 uniscrm-byok 后必须同步**：
1. 在 `uniscrm-byok` 仓库打新 tag 并 push
2. 更新 `uniscrm-web/link/package.json` 里的 tag 引用
3. 在 `uniscrm-web/link` 目录运行 `npm install`

否则生产环境构建（build 始终从 `uniscrm-web` 项目发起）不会用到新代码，导致公开仓库与实际部署代码不一致。

## Agent skills

### Issue tracker

Issues live in GitHub Issues (zcqqq/uniscrm-web), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary, label strings identical to role names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
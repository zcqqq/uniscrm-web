# TMS 管理控制台（第一个页面：X API 平台用量）

日期：2026-07-31
状态：设计已确认；Cloudflare Access 侧已配置并实测通过；待写实施计划

## 目标

给平台运营方（目前只有一人）一个管理界面，认证体系完全独立于租户 SaaS 的会话体系，租户用户在任何情况下都到达不了。

第一个也是目前唯一的页面：展示整个平台的 X API 消耗情况，数据来自
`GET https://api.x.com/2/usage/tweets`（[文档](https://docs.x.com/x-api/usage/get-usage)）。

## 现状（实施前必须知道的事实）

- `uniscrm-web/admin/` 是**纯后端计费 worker**，不是管理界面。它跑在 `admin.uni-scrm.com` /
  `admin-dev.uni-scrm.com`，只有 `/health`、`/internal/*`（`X-Internal-Secret` 头鉴权）、
  `/webhooks/stripe`，没有任何前端构建、没有面向人的登录。
- 租户 session cookie 的 domain 是 `uni-scrm.com`（`web/worker/auth/issue-session.ts:34`），
  **所有子域都会收到它**，包括 `admin.uni-scrm.com`。所以隔离必须是主动的，不能依赖"地址没人知道"。
- `X_BEARER_TOKEN` 是 `link` worker 的 secret（`link/.secrets.json`），dev 与 production 是**两个不同的
  X app**（`X_CLIENT_ID` 值不同），因此 dev 与 prod 看到的是各自 project 的用量。
- `link` 已有 `/internal/*` + `internalAuthMiddleware`，与 `admin` 共用 `INTERNAL_SECRET`。
- 代码库中此前**没有任何** super-admin / is_admin 概念。本设计是该概念的起点。
- `recharts@^3.9.0` 已在 `analytics` 中使用；`shared/frontend/ui/` 已有 `progress` / `card` /
  `table` / `tabs` / `alert` 等 shadcn 组件。

## 决策摘要

| 决策点 | 选择 | 理由 |
|---|---|---|
| 认证 | Cloudflare Access（Zero Trust），单个多域名 application | 边缘拦截，租户请求根本到不了 Worker；≤50 用户免费；零自研认证代码；单 app 意味着只有一个 AUD tag 要配 |
| 部署位置 | 复用现有 `admin` worker | 不新增 worker |
| 路径前缀 | `/tms`（UI + API + 静态资源全在其下） | Access app 一条路径盖全；`/internal/*` 与 `/webhooks/stripe` 完全不在 Access app 内，策略写错也炸不到 Stripe |
| X 凭据 | 保留在 `link`，admin 经 `/internal/x-usage` 取数 | X 凭据单一来源，admin 永不持有 |
| 数据存储 | 实时直读 + `caches.default` 缓存 10 分钟 | X 自身即返回最近 90 天日粒度，90 天内落库是纯冗余；符合"外部 API payload 不入库" |
| 前端 | Vite + React + shadcn（同 analytics） | 与全仓一致；以后加管理页不用推倒 |
| 环境 | dev + prod 都上 | localhost 验证不算完成，必须部署 dev 自测 |
| Worker 内二次校验 | 完整验 JWT，fail-closed | Access 被误删/误改也进不来 |

## 一、安全边界（三层，全部 fail-closed）

### 第一层：Cloudflare Access（边缘）

**一个** self-hosted application，挂两个域名 ×
两条路径 = **4 条 public destination**：

| 项 | 值 |
|---|---|
| Application | `UniSCRM TMS Console`，id `c4fefcbc-9c2a-48ae-a43d-7f075522b4b7` |
| Destinations | `admin.uni-scrm.com/tms`、`admin.uni-scrm.com/tms/*`、`admin-dev.uni-scrm.com/tms`、`admin-dev.uni-scrm.com/tms/*` |
| 策略 | `Owner only`：Allow → Include → Emails → `zhengchao.qqqqq@gmail.com` |
| IdP | `cloudflare`（One-time PIN，邮箱验证码）—— 无需注册任何外部 OAuth 应用 |
| Session duration | 24h |

**为什么每个域名要两条路径**：Access 的路径匹配**不覆盖子路径**。按
[app paths 文档](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)，
`example.com/alpha/*` 覆盖 `/alpha/one` 但**不覆盖** `/alpha` 本身；反之 `/tms` 也不覆盖
`/tms/api/x-usage`。只配 `/tms` 会让 API 与静态资源在边缘完全敞开（Worker 的 JWT 中间件仍会拦，
但那是第二道防线，不该被当成第一道用）。已实测确认。

用 [multi-domain application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#multi-domain-applications)
而非两个独立 app：同一 application 下所有域名共用同一套策略和**同一个 AUD tag**，因此 dev 与 prod 的
`wrangler.toml` 填入完全相同的两行。代价是 dev 与 prod 无法有不同策略 —— 本场景下策略本就相同，
不构成限制。

关键点：destination 都带 `/tms` 前缀而非裸域名。`/`、`/health`、`/internal/*`、`/webhooks/stripe`
**不属于任何 Access application**，行为与今天完全一致。默认是"不保护"，只有新增路径被保护 ——
这样策略配置出错的失败方向是"新页面进不去"，而不是"Stripe webhook 全挂"。

### 已完成的配置与实测结果

application 与策略已于 2026-07-31 经 Cloudflare API 创建完毕，取回的两项值：

- **team domain**：`billowing-brook-6d76.cloudflareaccess.com`
- **AUD tag**：`72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b`

（AUD tag 不是机密 —— 它以 `kid` 参数明文出现在 Access 登录跳转 URL 中，放 `wrangler.toml` vars 即可。）

实测（创建后约 1 分钟内 prod 的精确路径规则仍有传播延迟，之后恢复正常）：

| URL | 结果 |
|---|---|
| `admin.uni-scrm.com/tms` | 302 → Access 登录页 |
| `admin.uni-scrm.com/tms/api/x-usage` | 302 → Access 登录页 |
| `admin-dev.uni-scrm.com/tms` | 302 → Access 登录页 |
| `admin-dev.uni-scrm.com/tms/api/x-usage` | 302 → Access 登录页 |
| `admin.uni-scrm.com/health` | 200（未受影响）|
| `admin.uni-scrm.com/` | 404（未受影响）|
| `admin.uni-scrm.com/webhooks/stripe` | 404（GET 无此路由，未被 Access 拦截）|
| `admin.uni-scrm.com/internal/plans` | 401（内部鉴权照旧）|
| `admin-dev.uni-scrm.com/health` | 200（未受影响）|

### 第二层：Worker JWT 中间件

新增 `admin/src/middleware/access-auth.ts`，挂载于 `/tms` 与 `/tms/*`：

1. 读 `Cf-Access-Jwt-Assertion` 请求头（Access 注入）；缺失 → 403
2. 从 `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` 取 JWKS，用 `caches.default` 缓存 1 小时
   （Access 会轮换签名密钥，不可永久缓存）
3. 用 WebCrypto 做 RS256 验签（`crypto.subtle.importKey('jwk', ...)` + `crypto.subtle.verify`）
4. 校验 claims：
   - `iss` === `https://${ACCESS_TEAM_DOMAIN}`
   - `exp` 未过期
   - `aud` 包含本环境的 `ACCESS_AUD_TAG`
   - `email` ∈ `ADMIN_EMAILS`（逗号分隔的 var）
5. 任一环节失败 → `403 { "error": "Forbidden" }`，不回显失败原因细节
6. **`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD_TAG` / `ADMIN_EMAILS` 任一缺失或为空 → 直接 403**
   （fail-closed；"没配就放行"是明确拒绝的设计）

验签工具函数放 `admin/src/lib/jwt.ts`，约 60 行，**不引入 `jose`**。这里只是调用 WebCrypto 的标准
RS256 验签，不自行实现密码学算法。

### 第三层：显式拒绝租户会话

`access-auth.ts` **绝不读取 `session` cookie，也不 import `SessionService` / `TenantDB`**。
租户登录后访问 `/tms` 时其 session cookie 确实会到达本 worker（domain 是 `uni-scrm.com`），
必须确保它在此处没有任何语义。

单元测试钉死这一条：携带合法租户 `session` cookie、不带 Access JWT 的请求 → 403。

## 二、数据链路

```
浏览器（已通过 Access）
 └─ GET admin.uni-scrm.com/tms/api/x-usage?days=30
     ├─ [Cloudflare Access 边缘拦截]
     ├─ [accessAuth 中间件验 JWT]
     ├─ caches.default 命中？ → 直接返回（TTL 600s）
     └─ 未命中 → GET ${LINK_URL}/internal/x-usage?days=30
                  header: X-Internal-Secret
          └─ link → GET https://api.x.com/2/usage/tweets?days=30&usage.fields=...
                     header: Authorization: Bearer ${X_BEARER_TOKEN}
```

- `link/src/routes-internal.ts` 新增 `GET /internal/x-usage`，是 X bearer 的唯一持有方
- `usage.fields` 全量请求：
  `cap_reset_day,daily_client_app_usage,daily_project_usage,project_cap,project_id,project_usage`
- `days` 参数校验 1–90（X 的约束），越界 → 400；缺省 30
- **不落库**。X 返回的完整 payload 仅 `console.log`，符合"调用外部 API 返回的 payload 全量数据不存数据库"
- 缓存 key 使用自造 URL（`https://cache.internal/x-usage?days=30`），不复用真实请求 URL，避免与
  受保护路径的响应缓存混淆

### 新增配置

`admin/wrangler.toml`，dev 与 production 各一份：

| 名称 | 类型 | dev | production |
|---|---|---|---|
| `LINK_URL` | var | `https://link-dev.uni-scrm.com` | `https://link.uni-scrm.com` |
| `ACCESS_TEAM_DOMAIN` | var | `billowing-brook-6d76.cloudflareaccess.com` | **与 dev 相同** |
| `ACCESS_AUD_TAG` | var | `72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b` | **与 dev 相同**（单 app 单 AUD） |
| `ADMIN_EMAILS` | var | `zhengchao.qqqqq@gmail.com` | 同左 |

全部四项均已确定，Access 侧无遗留待办。

`INTERNAL_SECRET` 无需改动：dev 已在 `wrangler.toml` 中明文为 `dev-internal-secret`，production 已是 secret。

### 错误处理

`link` 或 X 返回非 2xx 时，admin 透传结构化错误 `{ error, upstream_status }`，页面据此显示具体原因
（bearer 失效 / X 限流 429 / link 不可达），而不是渲染一张空图表。

## 三、目录结构与路由

```
uniscrm-web/admin/
├── frontend/                        ← 新增
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   └── pages/XUsage.tsx
├── vite.config.ts                   ← 新增
├── dist/                            ← 构建产物，[assets] 绑定
└── src/
    ├── middleware/access-auth.ts    ← 新增
    ├── lib/jwt.ts                   ← 新增
    └── routes/tms-x-usage.ts        ← 新增
```

`vite.config.ts`：`root: "./frontend"`、`base: "/tms/"`、`build.outDir: "../dist"`、
plugins `react()` + `tailwindcss()`、dev server proxy `/tms/api` → `http://localhost:8792`。

`wrangler.toml` 顶层新增（与 `analytics` 一致）：

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "none"
run_worker_first = true
```

`run_worker_first = true` 意味着所有请求先进 Worker，静态资源不会自行暴露 —— 只有 Worker 显式调用
`ASSETS.fetch()` 才会被服务。这是本设计的默认安全属性。

`src/index.ts` 新增路由（现有路由一行不动）：

```ts
app.use("/tms", accessAuth);       // 两条都要：Hono 的 "/tms/*" 不匹配裸 "/tms"
app.use("/tms/*", accessAuth);
app.get("/tms/api/x-usage", xUsageRoute);
app.get("/tms", serveSpa);
app.get("/tms/*", serveSpa);
```

`serveSpa` 剥掉 `/tms` 前缀后转发给 `ASSETS.fetch()`（vite `base: "/tms/"` 产出的引用是
`/tms/assets/index-*.js`，而 `dist` 中实际路径是 `/assets/index-*.js`，故必须剥前缀）；
若 404 且 `Accept` 含 `text/html`，回退 `/index.html`。

`/`、`/health`、`/internal/*`、`/webhooks/stripe` 保持现状，根路径继续 404。

### 本地开发（明确的取舍）

`accessAuth` 是 fail-closed 的，本地 `wrangler dev` 没有 Access JWT，`/tms/*` 一律 403 ——
本地跑不通完整链路。**不提供"本地放行"开关**：这类开关正是最容易被误部署到线上的漏洞。

因此：vite dev 阶段用本地 mock JSON 迭代样式；真实验证一律部署到 `admin-dev.uni-scrm.com/tms` 后
在浏览器中完成。

## 四、页面内容

单页 `/tms`，锁定暗色主题以与产品一致，使用 `shared/frontend/ui/` 的 shadcn 组件。
**不引入** `Nav` / `Sidebar` / `TierGuard` / `useTier` —— 这些是租户向组件，会读 tier cookie。

- **总量卡**：`progress` 展示 `project_usage / project_cap`，附 `project_id` 与
  「每月 N 日重置」（`cap_reset_day`）
- **日趋势**：recharts 面积图，数据源 `daily_project_usage.usage`
- **按 client app 分解**：`table`，数据源 `daily_client_app_usage`，按 app 聚合并可展开看每日
- **days 切换**：`tabs`，7 / 30 / 90，切换即发一次新请求（各自独立缓存）
- **错误态**：`alert` 直陈原因（bearer 失效 / X 限流 / link 不可达）

## 五、测试

`admin/tests/unit/access-auth.test.ts` —— 用 WebCrypto 现场生成 RSA 密钥对签发测试 token、
mock JWKS 的 fetch：

- 无 `Cf-Access-Jwt-Assertion` 头 → 403
- **携带合法租户 `session` cookie、无 JWT → 403**
- 签名无效 → 403
- `aud` 不匹配 → 403
- `exp` 已过期 → 403
- `email` 不在 `ADMIN_EMAILS` 中 → 403
- `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD_TAG` / `ADMIN_EMAILS` 任一缺失 → 403
- 完全合法的 JWT → 放行

`admin/tests/unit/tms-x-usage.test.ts` —— 缓存命中与未命中路径、`days` 越界 → 400、
`link` 非 2xx 时的结构化透传、断言未写入任何 D1。

`link/tests/services/routes-internal-x-usage.test.ts` —— `X-Internal-Secret` 校验、
`usage.fields` 拼接正确、X 返回 401 / 429 时的透传。

前端不写单元测试（仓库中无前端测试基建），部署 dev 后在浏览器中自测。
vitest 需按已知问题固定 `miniflare.compatibilityDate`，避免 runner 默认取当天日期而与 workerd 版本冲突。

无异步队列流程、无 `_status` 后缀字段，因此不需要 `sequence.md` / `status.md`。

## 范围之外

- 平台其他 API 配额（YouTube quota 等）不在本次范围内，虽然 `link` 已有 `recordYouTubeQuota`
- 多管理员、角色区分、审计日志 —— 当前只有一名运营方，Access 的邮箱白名单已足够
- 90 天以上的历史归档 —— 若将来需要，再加 cron 快照落库

---

## 附录：X `/2/usage/tweets` 的实际返回行为（2026-08-01 dev 实测）

这些是照文档看不出来、但会直接决定消费端怎么写的事实。**已经因为其中第一条炸过一次整页白屏**，
所以记在这里。

1. **X 会省略空字段，而不是给空数组。** `daily_client_app_usage` 里 `usage_result_count` 为 0 的
   条目**完全没有 `usage` 键**（dev 的 8 个 client app 里 7 个如此）。所以消费端对任何嵌套数组
   都要 `?? []`，哪怕契约里没标 `?`。同理 `date` 等标量字段也可能缺失，取值前要防御。
2. **所有数值都是字符串。** `"project_cap": "2000000"`、`"project_usage": "1204"`、
   `"usage": "197"`。前端必须 `Number()` 强转后再计算，否则求和会变成字符串拼接。
   例外：`cap_reset_day` 是数字。
3. **`date` 是完整 ISO 时间戳**（`"2026-07-15T00:00:00.000Z"`），不是 `YYYY-MM-DD`。
4. dev 与 production 是**两个不同的 X app / project**，各自的用量互不相干。上面第 1 条的
   省略行为只在 dev 的 8 个 client app 上观测过，prod 未验证。

## 附录：dev 部署自测结果（2026-08-01）

| 检查项 | 结果 |
|---|---|
| `/tms`、`/tms/api/x-usage`、`/tms/assets/*` | 302 → Access 登录页 |
| `/`、`/index.html`、`/assets/` | 404（静态资源未从未受保护路径漏出）|
| `/health`、`/internal/plans` | 200 / 401，行为未变 |
| 带伪造租户 `session` cookie 请求 `/tms` 与 `/tms/api/x-usage` | 仍 302 → Access |
| 页面渲染 | 1,204 / 2,000,000 (0.1%)，重置日 10，7 个 client app |
| 天数切换 | 7/30/90 正常；7 天区间无数据时显示「该区间内没有用量记录。」|
| 缓存 | `days=90` 首次 `X-Cache: MISS`、二次 `HIT`（自造 key `https://cache.internal/` 在真实运行时可用）|
| 参数校验 | `days=0` / `days=200` → 400 |
| 未知 API 路径 | `/tms/api/does-not-exist` → 404 JSON，不回退成 SPA 的 HTML |

Access 登录走的是 `cloudflare` 类型 IdP（Cloudflare 账号登录），不是邮箱一次性验证码。

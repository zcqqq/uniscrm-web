# 账号密码登录设计（2026-07-30）

## Context

今天 `web` 模块有三条进入产品的路径：magic link（输邮箱即注册，无密码）、Google OAuth、X OAuth。三条都不需要密码，因此没有任何密码相关的代码或字段——这是一次从零新增。

需求是补上「账号 + 密码」登录；OAuth 注册的用户在 Settings 里设置或重置自己的密码。

## 已确认的决策

1. **只加登录，不加密码注册**。注册仍然只走 magic link 或 OAuth；密码是加在已有账号上的第二种凭证。这样邮箱所有权仍由现有流程证明，不需要再造一套邮箱验证，也不会出现「用别人的邮箱抢注」。
2. **不做独立的忘记密码流程**。登录页提示改用邮件登录链接，登进去后在 Settings 重设。magic link 本身就是一条已经证明邮箱所有权的兜底路径，再做一套 reset 邮件是 100% 重复建设。
3. **做防撞库限流**，KV 计数器 + 临时锁定。
4. 登录页的密码框**默认折叠**，由一个链接展开。默认路径与今天完全一致，不打扰已有用户。
5. 验证成功且哈希参数低于当前标准时**自动重算回写**（透明升级）。

## 探索核实的事实

- `members` 表（`web/migrations/0001_init.sql:8`）无任何密码字段；`email` 只有普通索引（第 47 行），**没有 UNIQUE 约束**。
- 全仓库无 bcrypt / scrypt / argon2 / pbkdf2 的任何使用。
- `members.email` 实测无重复、无 NULL：dev 8 行 / 8 个不同邮箱，prod 3 行 / 3 个不同邮箱。因此可以安全地补 UNIQUE 索引。
- workerd（与线上同一运行时）实测 PBKDF2-HMAC-SHA256 无迭代上限，耗时：10 万 = 5ms，21 万 = 13ms，**60 万 = 36ms**，100 万 = 60ms。OWASP 当前建议的 60 万迭代完全用得起，无需引入 WASM argon2 或 npm 依赖。
- session cookie 的落地逻辑（session / tier / lang 共 5 个 `setCookie`）目前内联在 `web/worker/api/auth.ts` 的 `/verify` 处理器里（第 94–120 行）。
- `web/src/pages/Login.tsx` 整页文案硬编码英文，未接 i18n；`Settings.tsx` 已接 i18n（`web/src/lib/i18n.ts`）。

## 实现方案

### 1. 凭证存储

`members` 新增一列 `password_hash TEXT`（可空，NULL 表示从未设过密码）。不建独立凭证表——目前只有一种凭证，建表属于 YAGNI。

编码格式把算法参数内联进字符串：

```
pbkdf2$sha256$600000$<salt_b64>$<hash_b64>
```

- PBKDF2-HMAC-SHA256，600,000 迭代，16 字节 `crypto.getRandomValues` salt，32 字节输出，全部走 WebCrypto。
- 验证时按串里携带的参数重算，而不是按代码里的常量——这样将来提高迭代数或更换算法既不用改表也不用一次性迁移。
- 验证成功且串里的参数低于当前标准时，用新参数重算并回写 `password_hash`。这是参数内联格式唯一的实际用处；代价是这部分登录会多一次 D1 写。
- 哈希比较使用常数时间比较。

新建 `web/worker/services/password.ts`，只导出纯函数（`hashPassword`、`verifyPassword`、`parseEncoded`、`needsUpgrade`），不依赖 D1 或 Hono，可独立单测。

### 2. 后端接口

**`POST /api/auth/password-login`（新增）**

独立路由，现有 magic link 的 `POST /api/auth/login` 一行不改。分开而不是给旧路由加一个可选 `password` 字段，理由是两者的失败模式、限流策略、返回体都不同，混在一个路由里前端还得分支判断。

请求 `{ email, password }`，成功后建 session 并落 cookie，返回体与 `/auth/verify` 一致（`{ ok, member, tenant }`）。

**`POST /api/settings/password`（新增）**

请求 `{ current_password?, new_password }`。member 已有 `password_hash` 时 `current_password` 必填且必须校验通过；为 NULL 时不需要（凭有效 session 即可设置）。

成功后**删除该 member 的其它所有 session，保留当前 session**——改密码的典型动机就是怀疑凭证泄露。

**`GET /api/settings/`（改动）**

返回体增加 `has_password: boolean`，供 Settings 页决定显示「设置密码」还是「修改密码」。

**复用性重构**：把 `auth.ts` `/verify` 里内联的 5 个 `setCookie` 抽成 `issueSession(c, member)`，magic link 与密码登录共用。不抽的话两处 cookie 逻辑迟早漂移。

### 3. 防撞库与信息泄露

KV key `login_fail:{email小写}`，值为失败次数，TTL 15 分钟。

- 连续失败 **5 次**后 `password-login` 直接返回 429，**不再比对哈希**；成功登录立即删除该 key。
- **锁定只作用于 password-login 路由**，不影响 magic link 与 OAuth。否则攻击者只要反复打错密码，就能把受害者彻底锁在门外——防护会变成 DoS 工具。
- 失败一律返回同一条 `Invalid email or password`，不区分「邮箱不存在」「该 member 未设置密码」与「密码错误」三种情况，否则该接口就是一个邮箱枚举器。
- 邮箱不存在、或该 member 的 `password_hash` 为 NULL 时，**同样跑一次 dummy PBKDF2、同样计入失败次数**。否则 36ms 的响应时间差、以及「这个邮箱永远不会返回 429」这两个信号都能被拿来枚举邮箱。也就是说 password-login 只在「member 存在 且 已设置密码 且 密码匹配」时才成功，其余一律走同一条失败分支。

计数维度取邮箱而非 IP：撞库的特征是同一账号被反复尝试，邮箱维度更贴合。

### 4. 数据库（`web/migrations/0010_member_password.sql`）

```sql
ALTER TABLE members ADD COLUMN password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email_unique ON members(email);
```

UNIQUE 索引是这次必须补的：密码登录按邮箱查人，而 `email` 至今只有普通索引，一旦出现重复行就会登进任意一个账号。已核实两个环境均无重复、无 NULL。

副作用：magic-link 的 `SELECT 再 INSERT` 存在 TOCTOU 窗口，加索引后并发注册的第二个请求会因唯一约束抛错，而不是静默建出重号。按 CLAUDE.md 的「数据准确性 > 系统稳定性」排序这是改善，但要在 catch 里重查一次让它优雅收敛到已存在的那行，而不是把 500 丢给用户。

### 5. 前端

**`web/src/pages/Settings.tsx`** 新增一张 Password 卡片：显示「已设置 / 未设置」，点击展开表单——新密码 + 确认密码，member 已有密码时额外要求当前密码。文案走现有 i18n，en/zh 同时补齐。复用 `shared/frontend/ui` 的既有组件，不写 inline CSS。

**`web/src/pages/Login.tsx`** 邮箱框下方增加一个「Sign in with password」链接，点击展开密码框；不展开时提交行为与今天完全一致（发 magic link）。旁边一句「忘记密码？改用邮件登录链接，登录后在 Settings 重设」。该页现状是整页硬编码英文，本次跟随现状，不引入半吊子 i18n。

**密码强度**：最少 8 字符，最多 128 字符，不强制大小写/数字/符号的组成规则（NIST SP 800-63B 现行建议为长度优先）。前端校验用于即时反馈，后端校验为权威。

### 6. 测试（`web/tests/`）

**单元**（`tests/unit/password.test.ts`）
- 哈希 → 验证往返成功；错误密码验证失败
- 同一密码两次哈希得到不同 salt，因而得到不同串
- 畸形串（字段数不对、base64 非法、迭代数非数字）被拒绝且不抛未捕获异常
- 低迭代数的串被判定为需要升级，当前参数的串不需要
- 长度边界：7 字符被拒、8 字符通过、129 字符被拒

**单元**（`tests/unit/login-throttle.test.ts`）
- 计数递增、达到阈值后判定为锁定、成功后清零

**接口**（`tests/api/password-login.test.ts`）
- 密码正确 → 200 且返回 member/tenant，session cookie 已落
- 密码错误 → 401 且错误信息为 `Invalid email or password`
- 邮箱不存在 → 401 且**错误信息与密码错误完全一致**
- member 存在但 `password_hash` 为 NULL → 401 且错误信息同上
- 邮箱不存在时**仍然调用了一次哈希函数**（用 spy 断言，而不是断言响应耗时——耗时断言必然不稳定）
- 连续失败 5 次后第 6 次 → 429，且该次不调用哈希验证
- 失败若干次后成功登录 → 计数被清零
- 被锁定期间 magic link 与 OAuth 路径仍可用（确认锁定没有外溢成 DoS）

**接口**（`tests/api/settings-password.test.ts`）
- 无密码的 member 首次设置：不带 `current_password` 也成功
- 已有密码的 member 缺 `current_password` → 400/401
- 已有密码的 member `current_password` 错误 → 401
- 设置成功后该 member 的其它 session 失效，当前 session 仍有效
- `GET /api/settings/` 的 `has_password` 在设置前后分别为 false / true

**回归**：现有 `tests/api/oauth.test.ts` 与 magic link 相关测试保持通过，确认两条老路径未受影响。

## 验证清单（实现完成后）

1. 上述测试全部通过；`web` 模块既有测试无新增失败（当前基线为 8 个失败，均为 session/middleware/recommend 的旧 KV mock，与本次无关）
2. migration 在 dev 库执行成功，`password_hash` 列与唯一索引就位
3. `npm run deploy:dev` 部署 web 模块后在浏览器实测：
   - OAuth 账号登录 → Settings 设置密码 → 登出 → 用邮箱+密码登录成功
   - 故意输错密码 5 次 → 第 6 次返回锁定提示；同一时刻 magic link 仍可发出
   - 修改密码后，另一个浏览器里的旧 session 被踢出
   - 未设置密码的账号用任意密码登录 → 与密码错误得到完全相同的提示

## 本期不做

- 独立的忘记密码邮件流程（决策 2）
- 删除已设置的密码（用户仍可通过 magic link 与 OAuth 登录，不存在锁死风险；有需要再加）
- 双因素认证
- 按 IP 维度的限流
- `Login.tsx` 的整页 i18n 化

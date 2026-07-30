# 账号密码登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已有账号加上「邮箱 + 密码」这第二种登录凭证，并让用户在 Settings 里设置或修改它。

**Architecture:** 密码只是加在既有 member 上的凭证，不是一条注册路径——注册仍然只走 magic link 与 OAuth，邮箱所有权由它们证明。哈希用 WebCrypto 的 PBKDF2-HMAC-SHA256，参数内联在存储串里以便日后无迁移升级。密码登录是一条独立路由，带 KV 限流，且所有失败情况收敛到同一个响应，避免变成邮箱枚举接口。

**Tech Stack:** Cloudflare Workers (workerd)、Hono、D1、KV、WebCrypto、React + vite、vitest + @cloudflare/vitest-pool-workers。

## Global Constraints

- 模块为 `uniscrm-web/web`，所有命令在 `uniscrm-web/web/` 目录下执行。
- 后端路由一律挂在 `/api/` 下（`/internal/` 留给服务间调用）。
- 前端不用 inline CSS，复用 `shared/frontend/ui/` 的既有组件。
- 所有对 `members` 的 SQL 必须带 tenant 作用域，否则要写 `// tenant-scope-ok: <理由>` 注释，`scripts/tenant-scope-audit.mjs` 会检查。
- 一律用全局 `wrangler`，不要 `npx wrangler`（npx 会拿到过期的本地 4.86）。
- 部署 dev 用 `npm run deploy:dev`；直接跑 `wrangler deploy --env dev` 会跳过 vite build 而发布陈旧的 `dist/`。
- 不要 `git stash`，也不要让文件跨工具调用停留在暂存区——本仓库有并发 session，暂存区是共享的。`git add` 与 `git commit` 必须在同一条命令里完成。
- 除非用户明确说 push to main，否则只在本地提交，不要 push。
- 密码长度限制逐字为：最少 8 字符，最多 128 字符，不强制大小写/数字/符号组成规则。
- 当前哈希参数逐字为：PBKDF2-HMAC-SHA256，600000 迭代，16 字节 salt，256 位输出。
- 登录失败提示逐字为：`Invalid email or password`（三种失败情况共用这一条）。
- 限流参数逐字为：连续失败 5 次锁定，窗口 15 分钟（900 秒）。
- 用 `vi.spyOn(moduleNamespace, "fn")` 打桩 ESM 具名导出在本仓库是可行的，已有先例：`web/tests/api/oauth.test.ts:100` 就是这么给 `task-executor` 的具名导出打的桩，而 `oauth.ts` 用的是具名 import。看到 Task 5 / Task 6 里 spy `password` 模块时不必改写成依赖注入。
- `res.headers.getSetCookie()` 在本模块的 vitest 环境可用，返回逐条 cookie 的字符串数组（已实测）。

---

### Task 1: 密码哈希服务

纯函数模块，不依赖 D1、KV 或 Hono，可独立单测。

**Files:**
- Create: `web/worker/services/password.ts`
- Test: `web/tests/unit/password.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `CURRENT_ITERATIONS: number`（600000）
  - `PASSWORD_MIN_LENGTH: number`（8）、`PASSWORD_MAX_LENGTH: number`（128）
  - `validatePassword(password: string): string | null` — 合规返回 `null`，否则返回给用户看的英文错误串
  - `hashPassword(password: string): Promise<string>` — 返回编码串
  - `verifyPassword(password: string, encoded: string): Promise<boolean>` — 串畸形时返回 `false`，不抛异常
  - `parseHash(encoded: string): ParsedHash | null`
  - `needsUpgrade(encoded: string): boolean`
  - `dummyVerify(password: string): Promise<void>` — 烧掉与真实验证等量的 CPU

- [ ] **Step 1: 写失败的测试**

创建 `web/tests/unit/password.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  parseHash,
  needsUpgrade,
  validatePassword,
  CURRENT_ITERATIONS,
} from "../../worker/services/password";

// 造一个「旧版本写下的」低迭代串，用来验证升级路径是真的可用，而不是只有一个布尔判断
async function legacyEncoded(password: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  return `pbkdf2$sha256$${iterations}$${b64(salt)}$${b64(new Uint8Array(bits))}`;
}

describe("hashPassword / verifyPassword", () => {
  it("正确密码往返成功", async () => {
    const encoded = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", encoded)).toBe(true);
  });

  it("错误密码被拒绝", async () => {
    const encoded = await hashPassword("correct horse battery");
    expect(await verifyPassword("Correct horse battery", encoded)).toBe(false);
  });

  it("每次哈希都换 salt，同一密码不会编码成同一个串", async () => {
    const a = await hashPassword("same password");
    const b = await hashPassword("same password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password", a)).toBe(true);
    expect(await verifyPassword("same password", b)).toBe(true);
  });

  it("把用到的参数写进串里", async () => {
    const encoded = await hashPassword("whatever you like");
    expect(encoded.startsWith(`pbkdf2$sha256$${CURRENT_ITERATIONS}$`)).toBe(true);
  });

  // 参数内联的意义就在这里：按串里的迭代数验证，而不是按代码里的常量
  it("能验证用更低迭代数存下来的旧串", async () => {
    const old = await legacyEncoded("legacy secret", 1000);
    expect(await verifyPassword("legacy secret", old)).toBe(true);
  });
});

describe("parseHash", () => {
  it("畸形串一律返回 null 且不抛异常", () => {
    const bad = [
      "",
      "not-a-hash",
      "pbkdf2$sha256$600000$onlyfour",
      "pbkdf2$sha512$600000$c2FsdA==$aGFzaA==",
      "pbkdf2$sha256$abc$c2FsdA==$aGFzaA==",
      "pbkdf2$sha256$0$c2FsdA==$aGFzaA==",
      "pbkdf2$sha256$600000$!!!$aGFzaA==",
      "scrypt$sha256$600000$c2FsdA==$aGFzaA==",
    ];
    for (const s of bad) expect(parseHash(s)).toBeNull();
  });
});

describe("verifyPassword 遇到畸形的库内串", () => {
  it("返回 false 而不是抛异常", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });
});

describe("needsUpgrade", () => {
  it("低于当前标准的串被标记为需要升级", async () => {
    expect(needsUpgrade(await legacyEncoded("x", 1000))).toBe(true);
  });

  it("当前标准的串不需要升级", async () => {
    expect(needsUpgrade(await hashPassword("current"))).toBe(false);
  });

  it("畸形串不会被误判成需要升级", () => {
    expect(needsUpgrade("nonsense")).toBe(false);
  });
});

describe("validatePassword", () => {
  it("7 字符被拒", () => expect(validatePassword("1234567")).toBeTruthy());
  it("8 字符通过", () => expect(validatePassword("12345678")).toBeNull());
  it("128 字符通过", () => expect(validatePassword("a".repeat(128))).toBeNull());
  it("129 字符被拒", () => expect(validatePassword("a".repeat(129))).toBeTruthy());
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/unit/password.test.ts`
Expected: FAIL，报错为无法解析 `../../worker/services/password`（模块尚不存在）

- [ ] **Step 3: 实现**

创建 `web/worker/services/password.ts`：

```ts
// member 密码的哈希与校验。
//
// 用 WebCrypto 的 PBKDF2-HMAC-SHA256：workerd 原生支持，不需要 npm 包也不需要 WASM。在 workerd
// 里实测 600,000 迭代约 36ms CPU，远在 Workers 限制之内，所以用得起 OWASP 当前的建议值。
//
// 编码串自带参数：
//   pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>
// 校验时读的是串里携带的参数，而不是下面的常量。这样以后提高迭代数或更换算法，既不用改表结构
// 也不用做一次性数据迁移——老串照样能验证通过，然后由 needsUpgrade 触发就地重算。

export const CURRENT_ITERATIONS = 600000;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const SALT_BYTES = 16;
const HASH_BITS = 256;

export interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

// 只限长度，不强制组成规则——NIST SP 800-63B 现行建议是长度优先，组成规则反而促使用户选出可预测
// 的密码。上限是为了挡住拿超长输入压 CPU 的请求。
export function validatePassword(password: string): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, CURRENT_ITERATIONS);
  return `pbkdf2$sha256$${CURRENT_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 5) return null;
  const [scheme, hashName, iterationsRaw, saltRaw, hashRaw] = parts;
  if (scheme !== "pbkdf2" || hashName !== "sha256") return null;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  try {
    return { iterations, salt: fromBase64(saltRaw), hash: fromBase64(hashRaw) };
  } catch {
    return null;
  }
}

// 常数时间比较。两边比的都已经是哈希而不是密码本身，但「两个哈希在第几字节开始不同」这点信息
// 白送出去没有任何好处，而杜绝它是免费的。
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.iterations);
  return timingSafeEqual(candidate, parsed.hash);
}

// 给「查无此人」和「这个 member 从没设过密码」两种情况烧掉与真实校验等量的 CPU。少了这一步，
// 「这个邮箱 2ms 就返回，那个要 36ms」本身就是一台 member 表的枚举器。
export async function dummyVerify(password: string): Promise<void> {
  await derive(password, new Uint8Array(SALT_BYTES), CURRENT_ITERATIONS);
}

export function needsUpgrade(encoded: string): boolean {
  const parsed = parseHash(encoded);
  return parsed !== null && parsed.iterations < CURRENT_ITERATIONS;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/password.test.ts`
Expected: PASS，18 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add web/worker/services/password.ts web/tests/unit/password.test.ts && git commit -m "feat(web): add PBKDF2 password hashing service"
```

---

### Task 2: 登录限流

**Files:**
- Create: `web/worker/services/login-throttle.ts`
- Test: `web/tests/unit/login-throttle.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `MAX_FAILURES: number`（5）、`WINDOW_SECONDS: number`（900）
  - `class LoginThrottle { constructor(kv: KVNamespace); isLocked(email: string): Promise<boolean>; recordFailure(email: string): Promise<void>; clear(email: string): Promise<void> }`

- [ ] **Step 1: 写失败的测试**

创建 `web/tests/unit/login-throttle.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { LoginThrottle, MAX_FAILURES, WINDOW_SECONDS } from "../../worker/services/login-throttle";

function fakeKV() {
  const store = new Map<string, string>();
  const puts: { key: string; ttl?: number }[] = [];
  return {
    store,
    puts,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      puts.push({ key, ttl: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

describe("LoginThrottle", () => {
  let kv: ReturnType<typeof fakeKV>;
  let throttle: LoginThrottle;

  beforeEach(() => {
    kv = fakeKV();
    throttle = new LoginThrottle(kv as unknown as KVNamespace);
  });

  it("没有失败记录时不算锁定", async () => {
    expect(await throttle.isLocked("a@example.com")).toBe(false);
  });

  it("失败次数达到阈值才锁定", async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await throttle.recordFailure("a@example.com");
    expect(await throttle.isLocked("a@example.com")).toBe(false);

    await throttle.recordFailure("a@example.com");
    expect(await throttle.isLocked("a@example.com")).toBe(true);
  });

  it("成功后清零", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await throttle.recordFailure("a@example.com");
    await throttle.clear("a@example.com");
    expect(await throttle.isLocked("a@example.com")).toBe(false);
  });

  // 大小写和空格不同的同一个邮箱必须落在同一个计数器上，否则改个大小写就绕过了限流
  it("邮箱按小写去空格归一", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await throttle.recordFailure("  A@Example.COM ");
    expect(await throttle.isLocked("a@example.com")).toBe(true);
  });

  it("每次写入都带窗口 TTL，锁定不会永久生效", async () => {
    await throttle.recordFailure("a@example.com");
    expect(kv.puts.at(-1)!.ttl).toBe(WINDOW_SECONDS);
  });

  // KV 里躺着一个非数字的脏值时不能把计数器搞成 NaN，否则从此再也锁不上
  it("脏值被当作 0 重新开始计数", async () => {
    kv.store.set("login_fail:a@example.com", "garbage");
    await throttle.recordFailure("a@example.com");
    expect(kv.store.get("login_fail:a@example.com")).toBe("1");
  });

  it("不同邮箱各自计数", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await throttle.recordFailure("a@example.com");
    expect(await throttle.isLocked("b@example.com")).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/unit/login-throttle.test.ts`
Expected: FAIL，无法解析 `../../worker/services/login-throttle`

- [ ] **Step 3: 实现**

创建 `web/worker/services/login-throttle.ts`：

```ts
// 密码登录的撞库防护。
//
// 刻意只作用在密码登录这一条路由上。如果做成「锁账号」，任何知道受害者邮箱的人只要反复提交错误
// 密码，就能把对方连同 magic link 和 OAuth 一起挡在门外——防护本身会变成拒绝服务工具。
//
// 计数维度取邮箱而不是 IP：撞库的特征是同一个账号被反复尝试，邮箱维度更贴合，也不会被换出口 IP
// 绕开。查无此人时同样计数，这样 429 不会反过来暴露「这个邮箱是注册过的」。

export const MAX_FAILURES = 5;
export const WINDOW_SECONDS = 15 * 60;

function key(email: string): string {
  return `login_fail:${email.trim().toLowerCase()}`;
}

export class LoginThrottle {
  constructor(private kv: KVNamespace) {}

  private async count(email: string): Promise<number> {
    const raw = await this.kv.get(key(email));
    if (raw === null) return 0;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  async isLocked(email: string): Promise<boolean> {
    return (await this.count(email)) >= MAX_FAILURES;
  }

  async recordFailure(email: string): Promise<void> {
    const next = (await this.count(email)) + 1;
    await this.kv.put(key(email), String(next), { expirationTtl: WINDOW_SECONDS });
  }

  async clear(email: string): Promise<void> {
    await this.kv.delete(key(email));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/login-throttle.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add web/worker/services/login-throttle.ts web/tests/unit/login-throttle.test.ts && git commit -m "feat(web): add KV-backed login throttle"
```

---

### Task 3: 数据库迁移与并发注册收敛

加 `password_hash` 列，并给 `members.email` 补唯一索引。补索引会让 magic link 注册路径里既有的 TOCTOU 窗口从「静默建出重号」变成「抛唯一约束错误」，所以要在同一个任务里把它收敛掉——这两件事必须一起评审。

**Files:**
- Create: `web/migrations/0010_member_password.sql`
- Modify: `web/worker/api/auth.ts:62-89`（`/verify` 里创建 member 的分支）
- Test: `web/tests/api/magic-link-race.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `members.password_hash` 列（`TEXT`，可空）；`idx_members_email_unique` 唯一索引

- [ ] **Step 1: 写迁移**

创建 `web/migrations/0010_member_password.sql`：

```sql
-- 密码是加在既有账号上的第二种凭证，永远不是一条注册路径。NULL 表示这个 member 至今只用过
-- magic link 或 OAuth。
ALTER TABLE members ADD COLUMN password_hash TEXT;

-- 密码登录要按邮箱把人查出来，所以邮箱必须唯一标识一行。在此之前它只有一个普通索引
-- （0001_init.sql:47），一旦出现重复行就会登进其中任意一个账号。加索引前已核实 dev（8 行）与
-- 生产（3 行）均无重复邮箱、无 NULL。
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email_unique ON members(email);
```

- [ ] **Step 2: 写失败的测试**

创建 `web/tests/api/magic-link-race.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAuthRouter } from "../../worker/api/auth";

// members.email 上的唯一索引把 /verify 里「先 SELECT 再 INSERT」的窗口给收窄了：并发点开同一个
// 邮箱的两条 magic link 时，慢的那个请求会撞上唯一约束。它应该重新读到先赢的那一行继续走完登录，
// 而不是把 500 丢给用户。
describe("POST /auth/verify 撞上唯一约束时", () => {
  let db: any;
  let app: Hono;
  let ctx: any;
  let insertAttempts: number;

  beforeEach(() => {
    insertAttempts = 0;
    const raced = {
      id: "member-winner",
      tenant_id: 42,
      email: "race@example.com",
      preferred_location: "global",
      language: "en",
      timezone: "Asia/Shanghai",
    };

    db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (sql.startsWith("SELECT * FROM magic_links")) {
              return {
                token: "t1",
                email: "race@example.com",
                expires_at: new Date(Date.now() + 60_000).toISOString(),
                used: 0,
                trial: null,
                timezone: "Asia/Shanghai",
              };
            }
            if (sql.includes("FROM members WHERE email")) {
              // 第一次查（INSERT 之前）没有；INSERT 撞车后再查，先赢的那行已经在了
              return insertAttempts === 0 ? null : raced;
            }
            if (sql.includes("FROM tenants WHERE email")) return { tenant_id: 42 };
            return null;
          }),
          run: vi.fn(async () => {
            if (sql.startsWith("INSERT INTO members")) {
              insertAttempts++;
              throw new Error("UNIQUE constraint failed: members.email");
            }
            return {};
          }),
        })),
      })),
    };

    ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() };

    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { WEB_DB: db, KV: {}, WEB_URL: "https://app.example.com" };
      return next();
    });
    app.route("/auth", createAuthRouter());
  });

  it("重新读到先赢的那一行并正常登录", async () => {
    const res = await app.request("/auth/verify?token=t1", {}, undefined, ctx);

    expect(insertAttempts).toBe(1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.member.id).toBe("member-winner");
    expect(body.tenant.id).toBe(42);
  });
});
```

- [ ] **Step 3: 跑测试确认它失败**

Run: `npx vitest run tests/api/magic-link-race.test.ts`
Expected: FAIL，INSERT 抛出的 `UNIQUE constraint failed` 一路冒泡，响应为 500 而不是 200

- [ ] **Step 4: 实现收敛逻辑**

修改 `web/worker/api/auth.ts`，把 `if (!member) { ... }` 分支里那条 `INSERT INTO members` 换成：

```ts
      const tz = resolveSignupTimezone(link.timezone, cfTimezone(c.req.raw));
      let createdMember = true;
      try {
        await c.env.WEB_DB.prepare(
          "INSERT INTO members (id, tenant_id, email, preferred_location, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(memberId, tenantId, link.email, "global", tz, now)
          .run();
      } catch (e) {
        // members.email 上的唯一索引堵住了上面那次 SELECT 与这次 INSERT 之间的窗口。并发点开同一
        // 邮箱的两条 magic link 时，慢的这个请求会到这里；重新读出先赢的那一行继续走完登录，而不是
        // 把 500 丢给用户。上面那条 tenants INSERT 已经落库了，会留下一行没人引用的 tenant——在这个
        // 极窄的竞态里宁可留个孤儿行，也不能让同一个邮箱存在两个 member。
        const raced = await c.env.WEB_DB.prepare(
          "SELECT id, tenant_id, email, preferred_location, language, timezone FROM members WHERE email = ?"
        )
          .bind(link.email)
          .first<{ id: string; tenant_id: number; email: string; preferred_location: string; language: string; timezone: string }>();
        if (!raced) throw e;
        member = raced;
        createdMember = false;
      }

      if (createdMember) {
        const tasks = new PendingTaskService(c.env.WEB_DB);
        const t1 = await tasks.create("provision-db", { tenant_id: tenantId });
        const t2 = await tasks.create("activate-trial", { tenant_id: tenantId, tier: "basic", days: 30 });
        c.executionCtx.waitUntil(executePendingTask(c.env, tasks, t1));
        c.executionCtx.waitUntil(executePendingTask(c.env, tasks, t2));

        member = { id: memberId, tenant_id: tenantId, email: link.email, preferred_location: "global", language: "en", timezone: tz };
      }
```

注意：原来紧跟在 INSERT 之后的建任务代码和 `member = {...}` 赋值都要移进 `if (createdMember)` 里——输给竞态的那个请求不能再触发一次 provision-db 与 activate-trial。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/api/magic-link-race.test.ts`
Expected: PASS

- [ ] **Step 6: 在 dev 库执行迁移并核对**

```bash
wrangler d1 migrations apply uniscrm-web-dev --env dev --remote
wrangler d1 execute uniscrm-web-dev --remote --command "SELECT name FROM pragma_index_list('members')"
wrangler d1 execute uniscrm-web-dev --remote --command "SELECT name FROM pragma_table_info('members') WHERE name='password_hash'"
```

Expected: 索引列表里出现 `idx_members_email_unique`；列查询返回一行 `password_hash`

- [ ] **Step 7: 提交**

```bash
git add web/migrations/0010_member_password.sql web/worker/api/auth.ts web/tests/api/magic-link-race.test.ts && git commit -m "feat(web): add password_hash column and unique member email index"
```

---

### Task 4: 抽出 issueSession

magic link、OAuth 与即将新增的密码登录必须落下完全相同的 cookie。目前这段逻辑内联在 `/verify` 里，不抽出来三条路径迟早漂移。这是一次行为不变的重构。

**Files:**
- Create: `web/worker/auth/issue-session.ts`
- Modify: `web/worker/api/auth.ts:91-120`
- Test: `web/tests/api/issue-session.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface SessionMember { id: string; tenant_id: number; email: string; language?: string | null }`
  - `issueSession(c: Context<{ Bindings: Env }>, member: SessionMember): Promise<string>` — 建 session、落 cookie、返回 sessionId

- [ ] **Step 1: 写失败的测试**

创建 `web/tests/api/issue-session.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { issueSession } from "../../worker/auth/issue-session";

describe("issueSession", () => {
  it("落下 session / tier / lang 三种 cookie，且都作用在父域上", async () => {
    const db = {
      prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })) })),
    };

    const app = new Hono();
    app.get("/go", async (c) => {
      (c.env as any) = { WEB_DB: db };
      await issueSession(c as any, { id: "m1", tenant_id: 7, email: "a@example.com", language: "zh" });
      return c.json({ ok: true });
    });

    const res = await app.request("/go");
    const cookies = res.headers.getSetCookie();

    // 跨模块共享是全靠父域 cookie 的：每个模块各自是独立 Worker、独立域名
    const sessionSet = cookies.filter((c) => c.startsWith("session=") && !c.includes("Max-Age=0"));
    expect(sessionSet).toHaveLength(1);
    expect(sessionSet[0]).toContain("Domain=uni-scrm.com");
    expect(sessionSet[0]).toContain("HttpOnly");

    expect(cookies.some((c) => c.startsWith("tier=basic"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("lang=zh"))).toBe(true);
  });

  it("language 缺省时落 en", async () => {
    const db = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })) })) };
    const app = new Hono();
    app.get("/go", async (c) => {
      (c.env as any) = { WEB_DB: db };
      await issueSession(c as any, { id: "m1", tenant_id: 7, email: "a@example.com", language: null });
      return c.json({ ok: true });
    });

    const res = await app.request("/go");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("lang=en"))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/api/issue-session.test.ts`
Expected: FAIL，无法解析 `../../worker/auth/issue-session`

- [ ] **Step 3: 实现**

创建 `web/worker/auth/issue-session.ts`：

```ts
import { setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env } from "../types";
import { SessionService } from "./session";

export interface SessionMember {
  id: string;
  tenant_id: number;
  email: string;
  language?: string | null;
}

// 进入产品的每一条路径——magic link、OAuth、密码登录——都必须落下完全相同的一组 cookie。集中在
// 这一个函数里，是防止三条路径各自演化、日后行为对不上的唯一办法。
export async function issueSession(c: Context<{ Bindings: Env }>, member: SessionMember): Promise<string> {
  const sessions = new SessionService(c.env.WEB_DB);
  const language = member.language || "en";
  const sessionId = await sessions.create(member.id, member.tenant_id, member.email, language);

  // 先清掉早期版本可能留下的 host-only session cookie，再落父域的那个；否则浏览器会同时持有两个
  // 同名 cookie，而 host-only 的那个优先级更高。
  setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/" });
  setCookie(c, "session", "", { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 0, path: "/", domain: "uni-scrm.com" });
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
    domain: "uni-scrm.com",
  });
  // tier 这里写死 "basic" 是既有行为，本次原样保留，不在密码登录里顺手改语义。
  setCookie(c, "tier", "basic", {
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    maxAge: 30 * 24 * 60 * 60,
    path: "/",
    domain: "uni-scrm.com",
  });
  // 供静态帮助中心（help.uni-scrm.com）挑文档语言
  setCookie(c, "lang", language, {
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
    maxAge: 365 * 24 * 60 * 60,
    path: "/",
    domain: "uni-scrm.com",
  });

  return sessionId;
}
```

- [ ] **Step 4: 让 /verify 改用它**

修改 `web/worker/api/auth.ts`：删掉 `/verify` 里从 `const sessions = new SessionService(...)` 到最后一个 `setCookie(c, "lang", ...)` 的整段（原第 91–120 行），替换为：

```ts
    await issueSession(c, member);
```

并在文件顶部增加 `import { issueSession } from "../auth/issue-session";`。若 `SessionService` 在该文件其余部分（`/logout`、`/me`）仍在使用，保留其 import；否则一并删除。

- [ ] **Step 5: 跑测试确认没有回归**

Run: `npx vitest run tests/api tests/unit`
Expected: PASS，`issue-session.test.ts` 与 `magic-link-race.test.ts` 全绿，既有 api/unit 测试无新增失败

- [ ] **Step 6: 提交**

```bash
git add web/worker/auth/issue-session.ts web/worker/api/auth.ts web/tests/api/issue-session.test.ts && git commit -m "refactor(web): extract issueSession so every login path lands the same cookies"
```

---

### Task 5: 密码登录接口

**Files:**
- Modify: `web/worker/api/auth.ts`（新增路由）
- Test: `web/tests/api/password-login.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `verifyPassword` / `hashPassword` / `dummyVerify` / `needsUpgrade`；Task 2 的 `LoginThrottle`；Task 4 的 `issueSession`
- Produces: `POST /api/auth/password-login`，请求体 `{ email: string; password: string }`，成功返回 `{ ok: true, member: {...}, tenant: {...} }`（形状与 `/auth/verify` 一致）

- [ ] **Step 1: 写失败的测试**

创建 `web/tests/api/password-login.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createAuthRouter } from "../../worker/api/auth";
import * as password from "../../worker/services/password";

const MEMBER = {
  id: "m1",
  tenant_id: 7,
  email: "a@example.com",
  preferred_location: "global",
  language: "en",
  timezone: "Asia/Shanghai",
  password_hash: "pbkdf2$sha256$600000$c2FsdHNhbHRzYWx0c2Ex$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYQ==",
};

function makeApp(memberRow: any, kvStore: Map<string, string>) {
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => (sql.includes("FROM members WHERE email") ? memberRow : null)),
        run: vi.fn(async () => ({})),
      })),
    })),
  };
  const kv = {
    get: async (k: string) => (kvStore.has(k) ? kvStore.get(k)! : null),
    put: async (k: string, v: string) => { kvStore.set(k, v); },
    delete: async (k: string) => { kvStore.delete(k); },
  };
  const app = new Hono();
  app.use("/*", (c, next) => {
    (c.env as any) = { WEB_DB: db, KV: kv, WEB_URL: "https://app.example.com" };
    return next();
  });
  app.route("/auth", createAuthRouter());
  return { app, db };
}

function post(app: Hono, body: object) {
  return app.request(
    "/auth/password-login",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    undefined,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  );
}

describe("POST /auth/password-login", () => {
  let kvStore: Map<string, string>;

  beforeEach(() => { kvStore = new Map(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("密码正确时建立 session 并返回 member 与 tenant", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    const { app } = makeApp(MEMBER, kvStore);

    const res = await post(app, { email: "a@example.com", password: "hunter22222" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.member.id).toBe("m1");
    expect(body.tenant.id).toBe(7);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("session=") && !c.includes("Max-Age=0"))).toBe(true);
  });

  it("密码错误时返回 401 与统一提示", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(MEMBER, kvStore);

    const res = await post(app, { email: "a@example.com", password: "wrongpassword" });

    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe("Invalid email or password");
  });

  // 下面三个用例是同一件事的三个面：这条路由不能变成邮箱枚举器
  it("邮箱不存在时返回与密码错误完全一致的响应", async () => {
    const { app } = makeApp(null, kvStore);

    const res = await post(app, { email: "nobody@example.com", password: "whatever12" });

    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe("Invalid email or password");
  });

  it("member 存在但从没设过密码时同样返回统一响应", async () => {
    const { app } = makeApp({ ...MEMBER, password_hash: null }, kvStore);

    const res = await post(app, { email: "a@example.com", password: "whatever12" });

    expect(res.status).toBe(401);
    expect((await res.json() as any).error).toBe("Invalid email or password");
  });

  // 用 spy 断言哈希确实被算了，而不是断言响应耗时——耗时断言必然不稳定
  it("邮箱不存在时依然烧掉一次哈希的 CPU", async () => {
    const dummy = vi.spyOn(password, "dummyVerify");
    const { app } = makeApp(null, kvStore);

    await post(app, { email: "nobody@example.com", password: "whatever12" });

    expect(dummy).toHaveBeenCalledTimes(1);
  });

  it("连续失败达阈值后直接 429，且不再比对哈希", async () => {
    const verify = vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(MEMBER, kvStore);

    for (let i = 0; i < 5; i++) await post(app, { email: "a@example.com", password: "wrongpassword" });
    verify.mockClear();

    const res = await post(app, { email: "a@example.com", password: "wrongpassword" });

    expect(res.status).toBe(429);
    expect(verify).not.toHaveBeenCalled();
  });

  it("成功登录后失败计数清零", async () => {
    const verify = vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(MEMBER, kvStore);

    for (let i = 0; i < 3; i++) await post(app, { email: "a@example.com", password: "wrongpassword" });
    expect(kvStore.get("login_fail:a@example.com")).toBe("3");

    verify.mockResolvedValue(true);
    await post(app, { email: "a@example.com", password: "hunter22222" });

    expect(kvStore.has("login_fail:a@example.com")).toBe(false);
  });

  it("缺 email 或 password 时返回 400", async () => {
    const { app } = makeApp(MEMBER, kvStore);
    expect((await post(app, { email: "a@example.com" })).status).toBe(400);
    expect((await post(app, { password: "hunter22222" })).status).toBe(400);
  });

  it("哈希参数低于当前标准时登录成功后就地重算回写", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3c2FsdG5ld3NhbHQ=$bmV3aGFzaG5ld2hhc2g=");
    const { app, db } = makeApp({ ...MEMBER, password_hash: "pbkdf2$sha256$1000$c2FsdA==$aGFzaA==" }, kvStore);

    await post(app, { email: "a@example.com", password: "hunter22222" });

    const updates = db.prepare.mock.calls.map((c: any[]) => c[0]).filter((s: string) => s.startsWith("UPDATE members SET password_hash"));
    expect(updates).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/api/password-login.test.ts`
Expected: FAIL，`/auth/password-login` 未注册，全部返回 404

- [ ] **Step 3: 实现**

修改 `web/worker/api/auth.ts`：顶部增加

```ts
import { dummyVerify, hashPassword, needsUpgrade, verifyPassword } from "../services/password";
import { LoginThrottle } from "../services/login-throttle";
```

并在 `createAuthRouter()` 内、`/login` 路由之后加入：

```ts
  // 三种失败情况——查无此人、该 member 没设过密码、密码不对——共用这一条提示。任何区分都会把这条
  // 路由变成邮箱枚举器。
  const INVALID_CREDENTIALS = "Invalid email or password";

  router.post("/password-login", async (c) => {
    const { email, password } = await c.req.json<{ email?: string; password?: string }>();
    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    const throttle = new LoginThrottle(c.env.KV);
    if (await throttle.isLocked(email)) {
      return c.json(
        { error: "Too many failed attempts. Try again in 15 minutes, or sign in with an email link." },
        429
      );
    }

    // tenant-scope-ok: 登录入口——这条查询的作用正是解析出该 member 属于哪个 tenant，此刻还没有会话
    const member = await c.env.WEB_DB.prepare(
      "SELECT id, tenant_id, email, preferred_location, language, timezone, password_hash FROM members WHERE email = ?"
    )
      .bind(email)
      .first<{
        id: string;
        tenant_id: number;
        email: string;
        preferred_location: string;
        language: string;
        timezone: string;
        password_hash: string | null;
      }>();

    // 没有这一行、或这一行没有密码时，照样烧掉一次哈希的 CPU 并照样计数。否则「2ms 就返回」和
    // 「这个邮箱永远不会被锁」这两个信号都能拿来枚举邮箱。
    if (!member?.password_hash) {
      await dummyVerify(password);
      await throttle.recordFailure(email);
      return c.json({ error: INVALID_CREDENTIALS }, 401);
    }

    if (!(await verifyPassword(password, member.password_hash))) {
      await throttle.recordFailure(email);
      return c.json({ error: INVALID_CREDENTIALS }, 401);
    }

    await throttle.clear(email);

    // 存储串自带参数，所以提高迭代数不需要迁移：验证通过的那一刻用新参数重算一次即可。
    if (needsUpgrade(member.password_hash)) {
      const upgraded = await hashPassword(password);
      // tenant-scope-ok: id 来自刚刚通过校验的那一行 member
      await c.env.WEB_DB.prepare("UPDATE members SET password_hash = ? WHERE id = ?")
        .bind(upgraded, member.id)
        .run();
    }

    await issueSession(c, member);

    return c.json({
      ok: true,
      member: {
        id: member.id,
        email: member.email,
        preferred_location: member.preferred_location,
        language: member.language || "en",
        timezone: member.timezone || "UTC",
      },
      tenant: { id: member.tenant_id, email: member.email },
    });
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/api/password-login.test.ts`
Expected: PASS，10 个用例全绿

- [ ] **Step 5: 跑租户作用域审计**

Run: `node ../scripts/tenant-scope-audit.mjs`
Expected: 通过；若报 `web/worker/api/auth.ts` 缺 tenant 作用域，检查上面两条 `// tenant-scope-ok:` 注释是否紧贴在对应 SQL 之前

- [ ] **Step 6: 提交**

```bash
git add web/worker/api/auth.ts web/tests/api/password-login.test.ts && git commit -m "feat(web): add password login route with throttling"
```

---

### Task 6: Settings 设置/修改密码接口

**Files:**
- Modify: `web/worker/auth/session.ts`（新增 `destroyOthers`）
- Modify: `web/worker/api/settings.ts:14-21`（`GET /` 增加 `has_password`）与新增 `POST /password`
- Test: `web/tests/api/settings-password.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `hashPassword` / `verifyPassword` / `validatePassword`
- Produces:
  - `SessionService.destroyOthers(memberId: string, keepSessionId: string): Promise<void>`
  - `POST /api/settings/password`，请求体 `{ new_password: string; current_password?: string }`，成功返回 `{ ok: true }`
  - `GET /api/settings/` 返回体增加 `has_password: boolean`

- [ ] **Step 1: 写失败的测试**

创建 `web/tests/api/settings-password.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createSettingsRouter } from "../../worker/api/settings";
import * as password from "../../worker/services/password";

function makeApp(memberRow: any) {
  const statements: { sql: string; args: any[] }[] = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: any[]) => {
        statements.push({ sql, args });
        return {
          first: vi.fn(async () => (sql.includes("FROM members WHERE id") ? memberRow : null)),
          run: vi.fn(async () => ({})),
        };
      }),
    })),
  };
  const app = new Hono();
  app.use("/*", (c, next) => {
    (c.env as any) = { WEB_DB: db };
    c.set("memberId" as never, "m1" as never);
    c.set("tenantId" as never, 7 as never);
    return next();
  });
  app.route("/settings", createSettingsRouter());
  return { app, db, statements };
}

function post(app: Hono, body: object) {
  return app.request("/settings/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "session=sess-current" },
    body: JSON.stringify(body),
  });
}

const WITH_PASSWORD = { preferred_location: "global", timezone: "UTC", password_hash: "pbkdf2$sha256$600000$c2FsdA==$aGFzaA==" };
const WITHOUT_PASSWORD = { preferred_location: "global", timezone: "UTC", password_hash: null };

describe("POST /settings/password", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // 从没设过密码的 member 拿有效 session 就是身份证明，不需要再提供旧密码
  it("从没设过密码时不带 current_password 也能设置", async () => {
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3$bmV3");
    const { app, statements } = makeApp(WITHOUT_PASSWORD);

    const res = await post(app, { new_password: "brandnewpass" });

    expect(res.status).toBe(200);
    expect(statements.some((s) => s.sql.startsWith("UPDATE members SET password_hash"))).toBe(true);
  });

  it("已有密码时缺 current_password 被拒", async () => {
    const { app } = makeApp(WITH_PASSWORD);
    const res = await post(app, { new_password: "brandnewpass" });
    expect(res.status).toBe(400);
  });

  it("已有密码时 current_password 错误被拒", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(false);
    const { app } = makeApp(WITH_PASSWORD);

    const res = await post(app, { new_password: "brandnewpass", current_password: "wrongpassword" });

    expect(res.status).toBe(401);
  });

  it("已有密码且 current_password 正确时修改成功", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3$bmV3");
    const { app, statements } = makeApp(WITH_PASSWORD);

    const res = await post(app, { new_password: "brandnewpass", current_password: "oldpassword1" });

    expect(res.status).toBe(200);
    expect(statements.some((s) => s.sql.startsWith("UPDATE members SET password_hash"))).toBe(true);
  });

  // 改密码的典型动机就是怀疑凭证泄露，别处还登着的必须踢掉
  it("成功后删掉该 member 的其它 session，保留当前这个", async () => {
    vi.spyOn(password, "verifyPassword").mockResolvedValue(true);
    vi.spyOn(password, "hashPassword").mockResolvedValue("pbkdf2$sha256$600000$bmV3$bmV3");
    const { app, statements } = makeApp(WITH_PASSWORD);

    await post(app, { new_password: "brandnewpass", current_password: "oldpassword1" });

    const del = statements.find((s) => s.sql.startsWith("DELETE FROM sessions WHERE member_id"));
    expect(del).toBeDefined();
    expect(del!.args).toEqual(["m1", "sess-current"]);
  });

  it("新密码不合规时返回 400 且不写库", async () => {
    const { app, statements } = makeApp(WITHOUT_PASSWORD);

    const res = await post(app, { new_password: "short" });

    expect(res.status).toBe(400);
    expect(statements.some((s) => s.sql.startsWith("UPDATE members SET password_hash"))).toBe(false);
  });
});

describe("GET /settings", () => {
  it("has_password 反映该 member 是否设过密码", async () => {
    const withPw = makeApp(WITH_PASSWORD);
    const a = await withPw.app.request("/settings", { headers: { Cookie: "session=sess-current" } });
    expect(((await a.json()) as any).has_password).toBe(true);

    const withoutPw = makeApp(WITHOUT_PASSWORD);
    const b = await withoutPw.app.request("/settings", { headers: { Cookie: "session=sess-current" } });
    expect(((await b.json()) as any).has_password).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run tests/api/settings-password.test.ts`
Expected: FAIL，`POST /settings/password` 返回 404；`has_password` 为 `undefined`

- [ ] **Step 3: 给 SessionService 加 destroyOthers**

在 `web/worker/auth/session.ts` 的 `destroy` 之后加入：

```ts
  // 改密码后调用：别处还登着的会话必须失效，只留下发起这次修改的那个。
  async destroyOthers(memberId: string, keepSessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM sessions WHERE member_id = ? AND id != ?")
      .bind(memberId, keepSessionId)
      .run();
  }
```

- [ ] **Step 4: 实现设置接口**

修改 `web/worker/api/settings.ts`：顶部增加

```ts
import { getCookie } from "hono/cookie";
import { SessionService } from "../auth/session";
import { hashPassword, validatePassword, verifyPassword } from "../services/password";
```

把 `GET /` 的查询与返回体改为：

```ts
  router.get("/", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    const member = await c.env.WEB_DB.prepare("SELECT preferred_location, timezone, password_hash FROM members WHERE id = ?")
      .bind(memberId)
      .first<{ preferred_location: string; timezone: string; password_hash: string | null }>();
    return c.json({
      preferred_location: member?.preferred_location ?? "global",
      timezone: member?.timezone ?? "UTC",
      // 前端据此决定显示「设置密码」还是「修改密码」；只回布尔值，永远不把哈希发给浏览器
      has_password: member?.password_hash != null,
    });
  });
```

并新增：

```ts
  router.post("/password", async (c) => {
    const memberId = c.get("memberId" as never) as string;
    const { current_password, new_password } = await c.req.json<{ current_password?: string; new_password?: string }>();

    const invalid = validatePassword(new_password ?? "");
    if (invalid) return c.json({ error: invalid }, 400);

    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    const member = await c.env.WEB_DB.prepare("SELECT password_hash FROM members WHERE id = ?")
      .bind(memberId)
      .first<{ password_hash: string | null }>();
    if (!member) return c.json({ error: "Unauthorized" }, 401);

    // 从没设过密码的 member，手里这个有效 session 就是身份证明——OAuth 注册的用户正是走这条路。
    // 一旦有了密码，再改就必须先证明自己知道旧的。
    if (member.password_hash) {
      if (!current_password) return c.json({ error: "Current password is required" }, 400);
      if (!(await verifyPassword(current_password, member.password_hash))) {
        return c.json({ error: "Current password is incorrect" }, 401);
      }
    }

    const hash = await hashPassword(new_password!);
    // tenant-scope-ok: id bound to session memberId (a member belongs to one tenant — the scoping key)
    await c.env.WEB_DB.prepare("UPDATE members SET password_hash = ? WHERE id = ?").bind(hash, memberId).run();

    // 改密码的典型动机就是怀疑凭证已经泄露，所以别处还登着的一律踢掉，只留当前这个。
    const sessionId = getCookie(c, "session") ?? "";
    await new SessionService(c.env.WEB_DB).destroyOthers(memberId, sessionId);

    return c.json({ ok: true });
  });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/api/settings-password.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 6: 提交**

```bash
git add web/worker/auth/session.ts web/worker/api/settings.ts web/tests/api/settings-password.test.ts && git commit -m "feat(web): let members set and change their password from settings"
```

---

### Task 7: 登录页密码入口

**Files:**
- Modify: `web/src/lib/api.ts:17-40`（auth 段）
- Modify: `web/src/hooks/useAuth.tsx:19-29, 54-57, 92-96`
- Modify: `web/src/pages/Login.tsx`

**Interfaces:**
- Consumes: Task 5 的 `POST /api/auth/password-login`
- Produces:
  - `api.auth.passwordLogin(email: string, password: string)`
  - `useAuth().passwordLogin(email: string, password: string): Promise<void>`

- [ ] **Step 1: 给 api client 加方法**

在 `web/src/lib/api.ts` 的 `auth` 对象里，`login` 之后加入：

```ts
    passwordLogin: (email: string, password: string) =>
      request<{ ok: boolean; member: { id: string; email: string; preferred_location: string; language: string; timezone: string }; tenant: { id: string; email: string } }>(
        "/auth/password-login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      ),
```

- [ ] **Step 2: 给 useAuth 加 passwordLogin**

修改 `web/src/hooks/useAuth.tsx`：`AuthState` 接口里 `login` 之后加一行

```ts
  passwordLogin: (email: string, password: string) => Promise<void>;
```

`login` 函数之后加入：

```ts
  const passwordLogin = async (email: string, password: string) => {
    const res = await api.auth.passwordLogin(email, password);
    setMember(res.member);
    setTenant(res.tenant);
    i18n.changeLanguage(res.member.language || "en");
  };
```

并把 provider 的 value 改为包含它：

```tsx
    <AuthContext.Provider value={{ member, tenant, loading, login, passwordLogin, logout, refresh, updateLocation, updateLanguage, updateTimezone }}>
```

- [ ] **Step 3: 改登录页**

修改 `web/src/pages/Login.tsx`。把组件顶部改成先调用全部 hook、再做提前返回——现在的写法是在 `useState` 之前就 `if (loading) return`，本次要往这个文件再加两个 state，必须先把顺序摆正：

```tsx
export function Login() {
  const { login, passwordLogin, member, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const trial = searchParams.get("trial");

  // 提前返回必须排在所有 hook 之后：登出状态下 loading 由 true 变 false 时，若提前返回夹在 hook
  // 中间，两次渲染调用的 hook 数量就不一致了。
  if (loading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  if (member) return <Navigate to="/" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      if (usePassword) {
        await passwordLogin(email, password);
      } else {
        await login(email, trial ?? undefined);
        setSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in");
    }
  };
```

密码登录成功后 `member` 被填上，组件重渲染即命中上面的 `<Navigate to="/" replace />`，不需要额外跳转代码。

把表单部分替换为：

```tsx
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
            />
            {usePassword && (
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                required
                autoFocus
              />
            )}
            <Button type="submit" className="w-full">
              {usePassword ? "Sign in" : "Sign in with Email"}
            </Button>
            {usePassword ? (
              <p className="text-sm text-muted-foreground text-center">
                Forgot your password? {" "}
                <button type="button" className="underline" onClick={() => { setUsePassword(false); setPassword(""); setError(""); }}>
                  Sign in with an email link
                </button>
                {" "} instead, then reset it in Settings.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground text-center">
                <button type="button" className="underline" onClick={() => { setUsePassword(true); setError(""); }}>
                  Sign in with password
                </button>
              </p>
            )}
          </form>
```

密码框默认折叠：不展开时提交行为与今天完全一致（发 magic link），已有用户的路径一点没变。该页现状是整页硬编码英文，本次跟随现状，不引入半吊子 i18n。

- [ ] **Step 4: 类型检查与构建**

Run: `npx tsc --noEmit 2>&1 | grep -E "Login|useAuth|api\.ts"`
Expected: 无输出（本次改动的三个文件没有新增类型错误；该模块存在与本次无关的既有 tsc 报错）

Run: `npx vite build --mode development`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/api.ts web/src/hooks/useAuth.tsx web/src/pages/Login.tsx && git commit -m "feat(web): add collapsed password field to the login page"
```

---

### Task 8: Settings 密码卡片

**Files:**
- Create: `web/src/components/PasswordCard.tsx`
- Modify: `web/src/lib/api.ts`（settings 段）
- Modify: `web/src/lib/i18n.ts`
- Modify: `web/src/pages/Settings.tsx`

**Interfaces:**
- Consumes: Task 6 的 `POST /api/settings/password` 与 `GET /api/settings/` 的 `has_password`
- Produces: `<PasswordCard />`，自取自身数据，无 props

- [ ] **Step 1: 给 api client 加方法**

修改 `web/src/lib/api.ts` 的 `settings` 段：把 `get` 的返回类型补全，并新增 `setPassword`：

```ts
    get: () => request<{ preferred_location: string; timezone: string; has_password: boolean }>("/settings"),
    setPassword: (new_password: string, current_password?: string) =>
      request<{ ok: boolean }>("/settings/password", {
        method: "POST",
        body: JSON.stringify({ new_password, current_password }),
      }),
```

- [ ] **Step 2: 加 i18n 文案**

修改 `web/src/lib/i18n.ts`，在 `en.translation` 里加一个 `password` 段：

```ts
      password: {
        title: "Password",
        notSet: "Not set — you sign in with an email link or a connected account",
        isSet: "Password is set",
        set: "Set password",
        change: "Change password",
        current: "Current password",
        new: "New password",
        confirm: "Confirm new password",
        save: "Save",
        cancel: "Cancel",
        mismatch: "The two passwords do not match",
        saved: "Password updated. Other devices have been signed out.",
      },
```

在 `zh.translation` 里加对应段：

```ts
      password: {
        title: "密码",
        notSet: "未设置——你目前通过邮件登录链接或已连接的账号登录",
        isSet: "已设置密码",
        set: "设置密码",
        change: "修改密码",
        current: "当前密码",
        new: "新密码",
        confirm: "确认新密码",
        save: "保存",
        cancel: "取消",
        mismatch: "两次输入的密码不一致",
        saved: "密码已更新，其它设备上的登录已被退出。",
      },
```

- [ ] **Step 3: 写组件**

创建 `web/src/components/PasswordCard.tsx`：

```tsx
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Label } from "../../../shared/frontend/ui/label";

export function PasswordCard() {
  const { t } = useTranslation();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings.get().then((res) => setHasPassword(res.has_password)).catch(() => setHasPassword(false));
  }, []);

  const reset = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // 两次输入一致这件事在本地判掉就行，没必要为它跑一趟网络
    if (next !== confirm) {
      setError(t("password.mismatch"));
      return;
    }
    setSaving(true);
    try {
      await api.settings.setPassword(next, hasPassword ? current : undefined);
      setHasPassword(true);
      setSaved(true);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("password.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {hasPassword === null ? "" : hasPassword ? t("password.isSet") : t("password.notSet")}
        </p>
        {saved && <p className="text-sm text-primary">{t("password.saved")}</p>}

        {!open ? (
          <Button variant="outline" onClick={() => { setSaved(false); setOpen(true); }} disabled={hasPassword === null}>
            {hasPassword ? t("password.change") : t("password.set")}
          </Button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {hasPassword && (
              <div className="space-y-1.5">
                <Label>{t("password.current")}</Label>
                <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{t("password.new")}</Label>
              <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} minLength={8} maxLength={128} required />
            </div>
            <div className="space-y-1.5">
              <Label>{t("password.confirm")}</Label>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={8} maxLength={128} required />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>{t("password.save")}</Button>
              <Button type="button" variant="ghost" onClick={reset}>{t("password.cancel")}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: 挂到 Settings 页**

修改 `web/src/pages/Settings.tsx`：顶部加 `import { PasswordCard } from "../components/PasswordCard";`，并在 Appearance 卡片与 Connected Accounts 卡片之间插入 `<PasswordCard />`。

- [ ] **Step 5: 类型检查与构建**

Run: `npx tsc --noEmit 2>&1 | grep -E "PasswordCard|Settings|api\.ts|i18n"`
Expected: 无输出

Run: `npx vite build --mode development`
Expected: 构建成功

- [ ] **Step 6: 跑全部测试**

Run: `npx vitest run`
Expected: 新增的 5 个测试文件全绿；既有失败数仍为 8（`tests/auth/session.test.ts` 4 个、`tests/auth/middleware.test.ts` 2 个、`tests/services/recommend.test.ts` 2 个，均为与本次无关的旧 KV mock）。若失败数超过 8，说明引入了回归，必须先修掉再继续。

- [ ] **Step 7: 提交**

```bash
git add web/src/components/PasswordCard.tsx web/src/lib/api.ts web/src/lib/i18n.ts web/src/pages/Settings.tsx && git commit -m "feat(web): add password card to settings"
```

---

### Task 9: 部署 dev 并在浏览器实测

localhost 通过不算完成——必须部署到 `web-dev.uni-scrm.com` 上验证。

**Files:** 无（仅部署与验证）

**Interfaces:**
- Consumes: 前八个任务的全部产出

- [ ] **Step 1: 确认 dev 库迁移已就位**

Run: `wrangler d1 migrations list uniscrm-web-dev --env dev --remote`
Expected: `0010_member_password.sql` 显示为已应用；若未应用，执行 `wrangler d1 migrations apply uniscrm-web-dev --env dev --remote`

- [ ] **Step 2: 部署**

```bash
cd uniscrm-web/web && npm run deploy:dev
```

Expected: 输出 `web-dev.uni-scrm.com (custom domain)`

- [ ] **Step 3: 浏览器实测**

用真实的已登录 Chrome 会话（先调 `tabs_context_mcp`），依次验证：

1. 打开 `https://web-dev.uni-scrm.com/settings` → Password 卡片显示「未设置」→ 设置一个密码 → 提示保存成功
2. 刷新页面 → Password 卡片变为「已设置」，按钮文案变为「修改密码」
3. 登出 → 登录页点「Sign in with password」→ 用刚设的邮箱和密码登录 → 成功进入产品
4. 登出 → 用**错误密码**登录 → 提示 `Invalid email or password`
5. 用一个**不存在的邮箱**加任意密码登录 → 提示与第 4 步**逐字相同**
6. 对同一邮箱连续输错 5 次 → 第 6 次出现锁定提示；此时在同一页面改用邮件登录链接，确认 magic link **仍能正常发出**（限流没有外溢成 DoS）
7. 重新登录后到 Settings 修改密码：不填当前密码 → 被拒；填错当前密码 → 被拒；填对 → 成功

- [ ] **Step 4: 核对密码没有以明文入库**

Run: `wrangler d1 execute uniscrm-web-dev --remote --command "SELECT email, substr(password_hash, 1, 22) AS prefix FROM members WHERE password_hash IS NOT NULL"`
Expected: 每行 `prefix` 均形如 `pbkdf2$sha256$600000$`，不含任何明文

- [ ] **Step 5: 汇报**

向用户汇报实测结果，包括第 3 步七项逐条的结论。不要 push 到 main——除非用户明确说了 push to main。

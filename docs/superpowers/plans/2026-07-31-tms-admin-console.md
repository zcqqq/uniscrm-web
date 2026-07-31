# TMS 管理控制台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `admin` worker 的 `/tms` 路径下加一个认证体系完全独立于租户 SaaS 的管理页面，展示平台级 X API 用量。

**Architecture:** Cloudflare Access 在边缘拦截 `/tms` 与 `/tms/*`（两个域名共 4 条 destination，已配置完毕）；Worker 内 `accessAuth` 中间件二次校验 Access 签发的 JWT（fail-closed，绝不读租户 `session` cookie）；数据由 admin 经 `X-Internal-Secret` 向 link worker 的 `/internal/x-usage` 取，link 是 `X_BEARER_TOKEN` 的唯一持有方；结果用 `caches.default` 缓存 10 分钟，不落库。

**Tech Stack:** Hono、Cloudflare Workers Assets、WebCrypto（RS256 验签，不引 jose）、Vite + React 19 + Tailwind 4、shadcn/ui（`shared/frontend/ui`）、recharts、vitest。

设计文档：`uniscrm-web/docs/superpowers/specs/2026-07-31-tms-admin-console-design.md`

## Global Constraints

- 工作目录一律是 `/Users/zc/Documents/UniSCRM/uniscrm-web`（本文件中所有路径相对于它）。
- `wrangler` 用全局的，不要 `npx wrangler`（npx 会取到过期的本地 4.86）。
- 每个任务结尾**只做本地 commit，绝不 push**。只有用户明确说"push to main"才推。
- `git add` 必须逐个文件路径写明，**禁止 `git add -A` / `git add .`** —— 同一仓库有其他 session 在并行改动，会被误吞。
- 部署 dev 一律 `npm run deploy:dev`（脚本里含 `vite build`）；手敲 `wrangler deploy --env dev` 会跳过前端构建、发出过期的 dist。
- 不得为本地开发添加任何"跳过 Access 校验"的开关、环境变量或代码分支。
- 调用外部 API 拿到的全量 payload 只能 `console.log`，不得写入任何数据库。
- 前端不写死颜色 hex，用 `var(--color-*)` 产品 token。
- 已确定并将在 Task 4 写进 `admin/wrangler.toml` 的四个值：
  - `ACCESS_TEAM_DOMAIN = "billowing-brook-6d76.cloudflareaccess.com"`（dev 与 production 相同）
  - `ACCESS_AUD_TAG = "72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b"`（dev 与 production 相同）
  - `ADMIN_EMAILS = "zhengchao.qqqqq@gmail.com"`（dev 与 production 相同）
  - `LINK_URL`：dev 为 `"https://link-dev.uni-scrm.com"`，production 为 `"https://link.uni-scrm.com"`
- X 用量接口的固定查询字段串（多处使用，逐字一致）：
  `cap_reset_day,daily_client_app_usage,daily_project_usage,project_cap,project_id,project_usage`
- **两个模块的测试运行时不一样，别搞混**：`link/` 有 `vitest.config.ts`，用
  `@cloudflare/vitest-pool-workers`，测试里 `import { env } from "cloudflare:test"`；
  `admin/` 没有 `vitest.config.ts`，跑的是普通 Node vitest，用仓库既有的 fake 对象与
  `vi.stubGlobal` 约定（见 `admin/tests/unit/webhook.test.ts`）。**不要给 admin 新增
  `vitest.config.ts`**，也就不存在 miniflare `compatibilityDate` 需要固定的问题。
  Node 20+ 的 `globalThis.crypto.subtle` 可用，所以 admin 侧能在测试里现场生成 RSA 密钥对。

## 文件结构

| 文件 | 职责 |
|---|---|
| `link/src/routes-internal.ts`（改） | 新增 `GET /internal/x-usage`；X bearer 的唯一持有方 |
| `link/tests/services/routes-internal-x-usage.test.ts`（建） | 上述路由的测试 |
| `admin/src/lib/jwt.ts`（建） | 纯函数：JWKS 拉取+缓存、RS256 验签、claims 校验。不碰 Hono |
| `admin/tests/unit/jwt.test.ts`（建） | 用现场生成的 RSA 密钥对测验签 |
| `admin/src/middleware/access-auth.ts`（建） | Hono 中间件：读头、调 jwt.ts、查邮箱白名单、fail-closed |
| `admin/tests/unit/access-auth.test.ts`（建） | 含"带租户 session cookie 仍 403"这条 |
| `admin/src/routes/tms-x-usage.ts`（建） | `/tms/api/x-usage`：参数校验、缓存、调 link、错误透传 |
| `admin/tests/unit/tms-x-usage.test.ts`（建） | 上述路由的测试 |
| `admin/src/types.ts`（改） | Env 增加 4 个 var + ASSETS |
| `admin/src/index.ts`（改） | 挂中间件与路由、SPA 资源服务 |
| `admin/wrangler.toml`（改） | `[assets]` + 两个环境的 vars |
| `admin/package.json`（改） | 前端依赖与 build/deploy 脚本 |
| `admin/tsconfig.json`（改） | 开 jsx 与 DOM lib，纳入 frontend |
| `admin/vite.config.ts`（建） | root=frontend、base=/tms/、outDir=../dist |
| `admin/frontend/`（建） | index.html / main.tsx / App.tsx / index.css / pages/XUsage.tsx |

---

### Task 1: link 新增 `GET /internal/x-usage`

**Files:**
- Modify: `link/src/routes-internal.ts`（在 `router.get("/channels/active", ...)` 那条路由之前插入，约 244 行处）
- Test: `link/tests/services/routes-internal-x-usage.test.ts`

**Interfaces:**
- Consumes: `link/src/types.ts` 的 `Env.X_BEARER_TOKEN: string`（已存在）；`internalAuthMiddleware`（已挂在 `/internal/*` 上，见 `link/src/index.ts:33`）
- Produces: `GET /internal/x-usage?days=<1..90>`
  - 200 → `{ data: { cap_reset_day, project_cap, project_id, project_usage, daily_project_usage, daily_client_app_usage } }`
  - 400 → `{ error: string }`（days 非法）
  - 500 → `{ error: "x_bearer_not_configured" }`
  - 502 → `{ error: "x_api_error" | "x_api_bad_json" | "x_api_no_data", upstream_status: number }`

- [ ] **Step 1: 写失败测试**

新建 `link/tests/services/routes-internal-x-usage.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../../src/index";
import { env } from "cloudflare:test";

const testSecret = "test-internal-secret";
const testEnv = { ...env, INTERNAL_SECRET: testSecret, X_BEARER_TOKEN: "test-bearer" };

const SAMPLE = {
  data: {
    cap_reset_day: 12,
    project_cap: 10000,
    project_id: "1234567890",
    project_usage: 4321,
    daily_project_usage: {
      project_id: 1234567890,
      usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }],
    },
    daily_client_app_usage: [
      {
        client_app_id: "app-1",
        usage_result_count: 1,
        usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }],
      },
    ],
  },
};

function req(path: string, headers: Record<string, string> = { "X-Internal-Secret": testSecret }) {
  return new Request(`https://link-dev.uni-scrm.com${path}`, { headers });
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /internal/x-usage", () => {
  it("rejects a request without the internal secret", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(req("/internal/x-usage", {}), testEnv);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects days outside 1..90 and non-integers without calling X", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["0", "91", "abc", "7.5", "-3"]) {
      const res = await worker.fetch(req(`/internal/x-usage?days=${bad}`), testEnv);
      expect(res.status, `days=${bad}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls X with the bearer token and the full usage.fields list, and returns data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/internal/x-usage?days=30"), testEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: SAMPLE.data });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    const u = new URL(String(calledUrl));
    expect(u.origin + u.pathname).toBe("https://api.x.com/2/usage/tweets");
    expect(u.searchParams.get("days")).toBe("30");
    expect(u.searchParams.get("usage.fields")).toBe(
      "cap_reset_day,daily_client_app_usage,daily_project_usage,project_cap,project_id,project_usage"
    );
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-bearer" });
  });

  it("defaults to 30 days when days is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SAMPLE), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(req("/internal/x-usage"), testEnv);
    expect(res.status).toBe(200);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("days")).toBe("30");
  });

  it("maps an X 429 to 502 with upstream_status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_error", upstream_status: 429 });
  });

  it("maps an X 401 to 502 with upstream_status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_error", upstream_status: 401 });
  });

  it("returns 500 when X_BEARER_TOKEN is unset, without calling X", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(req("/internal/x-usage?days=7"), { ...testEnv, X_BEARER_TOKEN: "" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "x_bearer_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 200 with unparseable body to 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>nope</html>", { status: 200 })));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_bad_json", upstream_status: 200 });
  });

  it("maps a 200 with no data field to 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ title: "boom" }] }), { status: 200 })
    ));
    const res = await worker.fetch(req("/internal/x-usage?days=7"), testEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "x_api_no_data", upstream_status: 200 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link
npx vitest run tests/services/routes-internal-x-usage.test.ts
```

Expected: 全部 FAIL —— 除"rejects a request without the internal secret"外，其余因路由不存在而收到 404。

- [ ] **Step 3: 实现路由**

在 `link/src/routes-internal.ts` 中，`router.get("/channels/active", ...)` 之前插入：

```ts
  // 平台级 X API 用量（TMS 管理控制台用）。link 是 X_BEARER_TOKEN 的唯一持有方，
  // admin worker 通过本路由取数，自己不持有 X 凭据。
  const X_USAGE_FIELDS =
    "cap_reset_day,daily_client_app_usage,daily_project_usage,project_cap,project_id,project_usage";

  router.get("/x-usage", async (c) => {
    const daysRaw = c.req.query("days");
    const days = daysRaw === undefined ? 30 : Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return c.json({ error: "days must be an integer between 1 and 90" }, 400);
    }
    if (!c.env.X_BEARER_TOKEN) {
      return c.json({ error: "x_bearer_not_configured" }, 500);
    }

    const url = new URL("https://api.x.com/2/usage/tweets");
    url.searchParams.set("days", String(days));
    url.searchParams.set("usage.fields", X_USAGE_FIELDS);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${c.env.X_BEARER_TOKEN}` },
    });
    const text = await res.text();
    // 全量 payload 只进日志，不入库。
    console.log(JSON.stringify({ event: "x_usage_fetch", status: res.status, days, body: text.slice(0, 4000) }));

    if (!res.ok) {
      return c.json({ error: "x_api_error", upstream_status: res.status }, 502);
    }
    let parsed: { data?: unknown };
    try {
      parsed = JSON.parse(text) as { data?: unknown };
    } catch {
      return c.json({ error: "x_api_bad_json", upstream_status: res.status }, 502);
    }
    if (!parsed.data) {
      return c.json({ error: "x_api_no_data", upstream_status: res.status }, 502);
    }
    return c.json({ data: parsed.data });
  });
```

注意 `const X_USAGE_FIELDS` 必须放在 `internalRoutes()` 函数体内、`router.get("/x-usage", ...)` 之前。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link
npx vitest run tests/services/routes-internal-x-usage.test.ts
npm run typecheck
```

Expected: 9 个测试全 PASS；typecheck 无错。

- [ ] **Step 5: 跑 link 全量测试确认没打断别的**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link
npx vitest run
```

Expected: 通过数不低于改动前。若有失败，先确认是否本次改动引入 —— `git stash` 是禁止的，改用 `git diff` 逐条核对。

- [ ] **Step 6: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add link/src/routes-internal.ts link/tests/services/routes-internal-x-usage.test.ts
git commit -m "feat(link): 新增 GET /internal/x-usage 读取平台级 X API 用量"
```

---

### Task 2: admin JWT 验签工具 `admin/src/lib/jwt.ts`

**Files:**
- Create: `admin/src/lib/jwt.ts`
- Test: `admin/tests/unit/jwt.test.ts`

**Interfaces:**
- Consumes: 无（纯函数模块，只用 WebCrypto 与 `fetch`）
- Produces:
  - `interface AccessJwk { kid: string; kty: string; alg: string; e: string; n: string; use?: string }`
  - `interface AccessJwtPayload { aud: string[] | string; email: string; exp: number; iat: number; iss: string; sub: string }`
  - `fetchAccessJwks(teamDomain: string, cache?: Cache): Promise<AccessJwk[]>`
  - `verifyAccessJwt(token: string, opts: { teamDomain: string; audTag: string; jwks: AccessJwk[]; now?: number }): Promise<AccessJwtPayload | null>` —— 任何校验失败一律返回 `null`，不抛异常、不区分原因

admin 的测试跑在普通 Node vitest 下（`admin/` 没有 `vitest.config.ts`，用的是仓库既有的 fake 对象约定），Node 20+ 的 `globalThis.crypto.subtle` 可用，因此可以在测试里现场生成 RSA 密钥对。

- [ ] **Step 1: 写失败测试**

新建 `admin/tests/unit/jwt.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAccessJwks, verifyAccessJwt, type AccessJwk } from "../../src/lib/jwt";

const TEAM = "billowing-brook-6d76.cloudflareaccess.com";
const AUD = "72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b";
const KID = "test-kid-1";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeKeys(): Promise<{ privateKey: CryptoKey; jwk: AccessJwk }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { kty: string; e: string; n: string };
  return {
    privateKey: pair.privateKey,
    jwk: { kid: KID, kty: exported.kty, alg: "RS256", e: exported.e, n: exported.n },
  };
}

async function signToken(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" }
): Promise<string> {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

const NOW = 1_800_000_000;
function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    aud: [AUD],
    email: "zhengchao.qqqqq@gmail.com",
    exp: NOW + 3600,
    iat: NOW,
    iss: `https://${TEAM}`,
    sub: "user-1",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("verifyAccessJwt", () => {
  it("accepts a fully valid token and returns its payload", async () => {
    const { privateKey, jwk } = await makeKeys();
    const token = await signToken(privateKey, validPayload());
    const result = await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW });
    expect(result?.email).toBe("zhengchao.qqqqq@gmail.com");
  });

  it("rejects a token whose signature does not match the JWKS key", async () => {
    const signer = await makeKeys();
    const other = await makeKeys();
    const token = await signToken(signer.privateKey, validPayload());
    // 用另一把公钥（同 kid）去验，签名必然对不上。
    const result = await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [other.jwk], now: NOW });
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { privateKey, jwk } = await makeKeys();
    const token = await signToken(privateKey, validPayload({ exp: NOW - 1 }));
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW })).toBeNull();
  });

  it("rejects a token whose aud does not contain the app's AUD tag", async () => {
    const { privateKey, jwk } = await makeKeys();
    const token = await signToken(privateKey, validPayload({ aud: ["some-other-app-aud"] }));
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW })).toBeNull();
  });

  it("rejects a token issued by a different team domain", async () => {
    const { privateKey, jwk } = await makeKeys();
    const token = await signToken(privateKey, validPayload({ iss: "https://evil.cloudflareaccess.com" }));
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW })).toBeNull();
  });

  it("rejects a token whose kid is not in the JWKS", async () => {
    const { privateKey, jwk } = await makeKeys();
    const token = await signToken(privateKey, validPayload(), { alg: "RS256", kid: "unknown-kid", typ: "JWT" });
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW })).toBeNull();
  });

  it("rejects alg:none even when the payload is otherwise perfect", async () => {
    const { jwk } = await makeKeys();
    const token = `${b64urlJson({ alg: "none", kid: KID, typ: "JWT" })}.${b64urlJson(validPayload())}.`;
    expect(await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW })).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    const { jwk } = await makeKeys();
    for (const bad of ["", "not-a-jwt", "a.b", "a.b.c.d", "!!!.???.***"]) {
      expect(await verifyAccessJwt(bad, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW }), bad).toBeNull();
    }
  });

  it("accepts aud given as a bare string rather than an array", async () => {
    const { privateKey, jwk } = await makeKeys();
    const token = await signToken(privateKey, validPayload({ aud: AUD }));
    expect((await verifyAccessJwt(token, { teamDomain: TEAM, audTag: AUD, jwks: [jwk], now: NOW }))?.sub).toBe("user-1");
  });
});

describe("fetchAccessJwks", () => {
  it("fetches the team's certs endpoint and returns its keys", async () => {
    const { jwk } = await makeKeys();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const keys = await fetchAccessJwks(TEAM);
    expect(keys).toEqual([jwk]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  });

  it("serves from the cache when present and does not hit the network", async () => {
    const { jwk } = await makeKeys();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const cache = {
      match: vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }))),
      put: vi.fn(),
    } as unknown as Cache;

    expect(await fetchAccessJwks(TEAM, cache)).toEqual([jwk]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes to the cache on a miss", async () => {
    const { jwk } = await makeKeys();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));
    const cache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn().mockResolvedValue(undefined) } as unknown as Cache;

    await fetchAccessJwks(TEAM, cache);
    expect((cache.put as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("throws when the certs endpoint is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    await expect(fetchAccessJwks(TEAM)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npx vitest run tests/unit/jwt.test.ts
```

Expected: FAIL —— 模块 `../../src/lib/jwt` 不存在。

- [ ] **Step 3: 实现**

新建 `admin/src/lib/jwt.ts`：

```ts
// Cloudflare Access 签发的 JWT 校验。刻意不引入 jose：这里只是调用 WebCrypto 的标准
// RS256 验签，没有自行实现任何密码学算法。
export interface AccessJwk {
  kid: string;
  kty: string;
  alg: string;
  e: string;
  n: string;
  use?: string;
}

export interface AccessJwtPayload {
  aud: string[] | string;
  email: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
}

const JWKS_TTL_SECONDS = 3600;

function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input))) as T;
}

// Access 会轮换签名密钥，所以 JWKS 只能短期缓存，不能常驻。
export async function fetchAccessJwks(teamDomain: string, cache?: Cache): Promise<AccessJwk[]> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const cacheKey = new Request(url);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return ((await hit.json()) as { keys: AccessJwk[] }).keys;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: AccessJwk[] };

  if (cache) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${JWKS_TTL_SECONDS}` },
      })
    );
  }
  return body.keys;
}

// 任何一步不满足都返回 null —— 调用方只需知道"不通过"，不需要知道为什么，
// 也不该把原因回显给请求方。
export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; audTag: string; jwks: AccessJwk[]; now?: number }
): Promise<AccessJwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: AccessJwtPayload;
  try {
    header = base64UrlToJson<{ alg?: string; kid?: string }>(headerB64);
    payload = base64UrlToJson<AccessJwtPayload>(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;
  const jwk = opts.jwks.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, e: jwk.e, n: jwk.n, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (payload.iss !== `https://${opts.teamDomain}`) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.audTag)) return null;
  if (!payload.email) return null;

  return payload;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npx vitest run tests/unit/jwt.test.ts
```

Expected: 13 个测试全 PASS。

若 `Cache` 类型在 admin 的 tsconfig 下未定义，说明 `types` 里缺 workers-types —— 它已经在 `admin/tsconfig.json` 的 `"types": ["@cloudflare/workers-types/2023-07-01"]` 中，不需要改动。

- [ ] **Step 5: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add admin/src/lib/jwt.ts admin/tests/unit/jwt.test.ts
git commit -m "feat(admin): 新增 Cloudflare Access JWT 验签工具（WebCrypto RS256）"
```

---

### Task 3: admin `accessAuth` 中间件

**Files:**
- Create: `admin/src/middleware/access-auth.ts`
- Modify: `admin/src/types.ts`（Env 增加 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD_TAG` / `ADMIN_EMAILS`）
- Test: `admin/tests/unit/access-auth.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `fetchAccessJwks(teamDomain, cache?)`、`verifyAccessJwt(token, { teamDomain, audTag, jwks, now? })`、`AccessJwk`
- Produces: `accessAuth(c: Context<{ Bindings: Env }>, next: Next)` —— 通过则把邮箱写进 `c.set("adminEmail", ...)` 并 `await next()`；否则一律 `c.json({ error: "Forbidden" }, 403)`

- [ ] **Step 1: 写失败测试**

新建 `admin/tests/unit/access-auth.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { accessAuth } from "../../src/middleware/access-auth";
import type { AccessJwk } from "../../src/lib/jwt";

const TEAM = "billowing-brook-6d76.cloudflareaccess.com";
const AUD = "72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b";
const KID = "test-kid-1";
const OWNER = "zhengchao.qqqqq@gmail.com";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function makeKeys(): Promise<{ privateKey: CryptoKey; jwk: AccessJwk }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { kty: string; e: string; n: string };
  return { privateKey: pair.privateKey, jwk: { kid: KID, kty: pub.kty, alg: "RS256", e: pub.e, n: pub.n } };
}

async function signToken(privateKey: CryptoKey, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64urlJson({
    aud: [AUD], email, exp: now + 3600, iat: now, iss: `https://${TEAM}`, sub: "user-1",
  })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

const fullEnv = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD_TAG: AUD, ADMIN_EMAILS: OWNER };

function makeApp() {
  const app = new Hono();
  app.use("/tms", accessAuth as never);
  app.use("/tms/*", accessAuth as never);
  app.get("/tms", (c) => c.json({ ok: true, email: c.get("adminEmail" as never) }));
  app.get("/tms/api/x-usage", (c) => c.json({ ok: true }));
  return app;
}

function stubJwks(jwk: AccessJwk) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

describe("accessAuth", () => {
  it("lets a valid Access JWT through and exposes the email", async () => {
    const { privateKey, jwk } = await makeKeys();
    stubJwks(jwk);
    const res = await makeApp().request(
      "/tms",
      { headers: { "Cf-Access-Jwt-Assertion": await signToken(privateKey, OWNER) } },
      fullEnv
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: OWNER });
  });

  it("rejects a request with no Cf-Access-Jwt-Assertion header", async () => {
    const { jwk } = await makeKeys();
    stubJwks(jwk);
    const res = await makeApp().request("/tms", {}, fullEnv);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  // 这条是本设计的核心不变量：租户 session cookie 的 domain 是 uni-scrm.com，
  // 它必然会到达 admin.uni-scrm.com。它在 /tms 下不得有任何语义。
  it("rejects a request carrying a tenant session cookie but no Access JWT", async () => {
    const { jwk } = await makeKeys();
    stubJwks(jwk);
    const res = await makeApp().request(
      "/tms",
      { headers: { Cookie: "session=a-perfectly-valid-tenant-session-id; tier=pro" } },
      fullEnv
    );
    expect(res.status).toBe(403);
  });

  it("rejects an email that is not in ADMIN_EMAILS", async () => {
    const { privateKey, jwk } = await makeKeys();
    stubJwks(jwk);
    const res = await makeApp().request(
      "/tms",
      { headers: { "Cf-Access-Jwt-Assertion": await signToken(privateKey, "intruder@example.com") } },
      fullEnv
    );
    expect(res.status).toBe(403);
  });

  it("matches ADMIN_EMAILS case-insensitively and tolerates spaces in the list", async () => {
    const { privateKey, jwk } = await makeKeys();
    stubJwks(jwk);
    const res = await makeApp().request(
      "/tms",
      { headers: { "Cf-Access-Jwt-Assertion": await signToken(privateKey, "ZhengChao.QQQQQ@Gmail.com") } },
      { ...fullEnv, ADMIN_EMAILS: " other@example.com , zhengchao.qqqqq@gmail.com " }
    );
    expect(res.status).toBe(200);
  });

  it("rejects a token signed by a key that is not in the JWKS", async () => {
    const signer = await makeKeys();
    const served = await makeKeys();
    stubJwks(served.jwk);
    const res = await makeApp().request(
      "/tms",
      { headers: { "Cf-Access-Jwt-Assertion": await signToken(signer.privateKey, OWNER) } },
      fullEnv
    );
    expect(res.status).toBe(403);
  });

  // fail-closed：配置缺失时必须拒绝，绝不能"没配就放行"。
  it("rejects when any required var is missing or empty", async () => {
    const { privateKey, jwk } = await makeKeys();
    const token = await signToken(privateKey, OWNER);
    const broken = [
      { ...fullEnv, ACCESS_TEAM_DOMAIN: "" },
      { ...fullEnv, ACCESS_AUD_TAG: "" },
      { ...fullEnv, ADMIN_EMAILS: "" },
      { ...fullEnv, ADMIN_EMAILS: "  ,  " },
      { ACCESS_AUD_TAG: AUD, ADMIN_EMAILS: OWNER },
      { ACCESS_TEAM_DOMAIN: TEAM, ADMIN_EMAILS: OWNER },
      { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD_TAG: AUD },
    ];
    for (const [i, env] of broken.entries()) {
      stubJwks(jwk);
      const res = await makeApp().request("/tms", { headers: { "Cf-Access-Jwt-Assertion": token } }, env);
      expect(res.status, `broken env #${i}`).toBe(403);
    }
  });

  it("rejects when the JWKS endpoint is unreachable", async () => {
    const { privateKey } = await makeKeys();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await makeApp().request(
      "/tms",
      { headers: { "Cf-Access-Jwt-Assertion": await signToken(privateKey, OWNER) } },
      fullEnv
    );
    expect(res.status).toBe(403);
  });

  it("guards nested paths such as the API route", async () => {
    const { jwk } = await makeKeys();
    stubJwks(jwk);
    const res = await makeApp().request("/tms/api/x-usage", {}, fullEnv);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npx vitest run tests/unit/access-auth.test.ts
```

Expected: FAIL —— 模块 `../../src/middleware/access-auth` 不存在。

- [ ] **Step 3: 扩展 Env**

修改 `admin/src/types.ts`，在 `ENVIRONMENT: string;` 之后加：

```ts
  // TMS 管理控制台（/tms）
  LINK_URL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD_TAG: string;
  ADMIN_EMAILS: string;
  ASSETS: Fetcher;
```

- [ ] **Step 4: 实现中间件**

新建 `admin/src/middleware/access-auth.ts`：

```ts
import type { Context, Next } from "hono";
import type { Env } from "../types";
import { fetchAccessJwks, verifyAccessJwt } from "../lib/jwt";

// /tms 下所有请求的应用层第二道防线。第一道是 Cloudflare Access 在边缘拦截。
//
// 刻意不读 `session` cookie，也不 import SessionService / TenantDB：租户会话 cookie 的
// domain 是 uni-scrm.com，它必然会到达本 worker，但在 /tms 下不得有任何语义。
export async function accessAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  const audTag = c.env.ACCESS_AUD_TAG;
  const emails = (c.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  // Fail closed：任何一项配置缺失都拒绝，绝不"没配就放行"。
  if (!teamDomain || !audTag || emails.length === 0) {
    console.error(JSON.stringify({
      event: "tms_access_misconfigured",
      hasTeamDomain: !!teamDomain,
      hasAudTag: !!audTag,
      emailCount: emails.length,
    }));
    return c.json({ error: "Forbidden" }, 403);
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "Forbidden" }, 403);

  let payload: Awaited<ReturnType<typeof verifyAccessJwt>>;
  try {
    const cache = typeof caches !== "undefined" ? caches.default : undefined;
    const jwks = await fetchAccessJwks(teamDomain, cache);
    payload = await verifyAccessJwt(token, { teamDomain, audTag, jwks });
  } catch (err) {
    console.error(JSON.stringify({ event: "tms_access_verify_error", error: String(err) }));
    return c.json({ error: "Forbidden" }, 403);
  }

  if (!payload) return c.json({ error: "Forbidden" }, 403);
  if (!emails.includes(payload.email.toLowerCase())) {
    console.warn(JSON.stringify({ event: "tms_access_email_denied", email: payload.email }));
    return c.json({ error: "Forbidden" }, 403);
  }

  c.set("adminEmail" as never, payload.email);
  await next();
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npx vitest run tests/unit/access-auth.test.ts
npm run typecheck
```

Expected: 9 个测试全 PASS；typecheck 无错。

- [ ] **Step 6: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add admin/src/middleware/access-auth.ts admin/src/types.ts admin/tests/unit/access-auth.test.ts
git commit -m "feat(admin): 新增 accessAuth 中间件，fail-closed 校验 Access JWT"
```

---

### Task 4: `/tms/api/x-usage` 路由、wrangler 配置与路由挂载

**Files:**
- Create: `admin/src/routes/tms-x-usage.ts`
- Modify: `admin/src/index.ts`
- Modify: `admin/wrangler.toml`
- Test: `admin/tests/unit/tms-x-usage.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GET ${LINK_URL}/internal/x-usage?days=N`（带 `X-Internal-Secret` 头）；Task 3 的 `accessAuth`；Task 3 扩展的 `Env.LINK_URL` / `Env.INTERNAL_SECRET`
- Produces: `tmsXUsageRoute(c: Context<{ Bindings: Env }>): Promise<Response>`
  - 200 → link 的响应体原样透传，附 `X-Cache: HIT|MISS`
  - 400 → `{ error: string }`
  - 502 → `{ error: "upstream_error", upstream_status: number }`

本任务只挂 API 路由与配置；SPA 资源服务在 Task 5。

- [ ] **Step 1: 写失败测试**

新建 `admin/tests/unit/tms-x-usage.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { tmsXUsageRoute } from "../../src/routes/tms-x-usage";

const SAMPLE = {
  data: {
    cap_reset_day: 12,
    project_cap: 10000,
    project_id: "1234567890",
    project_usage: 4321,
    daily_project_usage: { project_id: 1234567890, usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }] },
    daily_client_app_usage: [
      { client_app_id: "app-1", usage_result_count: 1, usage: [{ date: "2026-07-30T00:00:00.000Z", usage: 120 }] },
    ],
  },
};

const baseEnv = { LINK_URL: "https://link-dev.uni-scrm.com", INTERNAL_SECRET: "dev-internal-secret" };

// caches.default 在 Node vitest 下不存在，路由会走无缓存分支；缓存命中/写入路径由
// 下面的 stubCaches 显式注入验证。
function makeApp() {
  const app = new Hono();
  app.get("/tms/api/x-usage", tmsXUsageRoute as never);
  return app;
}

function stubCaches(match: Response | undefined) {
  const put = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(match), put } });
  return put;
}

afterEach(() => vi.unstubAllGlobals());

describe("GET /tms/api/x-usage", () => {
  it("proxies to link with the internal secret and returns the payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await makeApp().request("/tms/api/x-usage?days=30", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://link-dev.uni-scrm.com/internal/x-usage?days=30");
    expect((init as RequestInit).headers).toMatchObject({ "X-Internal-Secret": "dev-internal-secret" });
  });

  it("defaults to 30 days", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await makeApp().request("/tms/api/x-usage", {}, baseEnv);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://link-dev.uni-scrm.com/internal/x-usage?days=30");
  });

  it("rejects days outside 1..90 without calling link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["0", "91", "abc", "7.5", "-3"]) {
      const res = await makeApp().request(`/tms/api/x-usage?days=${bad}`, {}, baseEnv);
      expect(res.status, `days=${bad}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a link 502 to 502 with upstream_status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "x_api_error", upstream_status: 429 }), { status: 502 })
    ));
    const res = await makeApp().request("/tms/api/x-usage?days=7", {}, baseEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_error", upstream_status: 502 });
  });

  it("serves a cache hit without calling link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stubCaches(new Response(JSON.stringify(SAMPLE), { headers: { "Content-Type": "application/json" } }));

    const res = await makeApp().request("/tms/api/x-usage?days=30", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(await res.json()).toEqual(SAMPLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes to the cache on a miss, keyed by days", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(SAMPLE), { status: 200 })));
    const put = stubCaches(undefined);

    const res = await makeApp().request("/tms/api/x-usage?days=7", {}, baseEnv);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(put).toHaveBeenCalledTimes(1);
    expect(String((put.mock.calls[0][0] as Request).url)).toBe("https://cache.internal/x-usage?days=7");
  });

  it("does not cache an upstream failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 502 })));
    const put = stubCaches(undefined);
    await makeApp().request("/tms/api/x-usage?days=7", {}, baseEnv);
    expect(put).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npx vitest run tests/unit/tms-x-usage.test.ts
```

Expected: FAIL —— 模块 `../../src/routes/tms-x-usage` 不存在。

- [ ] **Step 3: 实现路由**

新建 `admin/src/routes/tms-x-usage.ts`：

```ts
import type { Context } from "hono";
import type { Env } from "../types";

const CACHE_TTL_SECONDS = 600;

// 平台级 X API 用量。X 自身即返回最近 90 天的日粒度数据，因此不落库；
// 短缓存只是为了挡住连点刷新，避免打满 X 的限流。
export async function tmsXUsageRoute(c: Context<{ Bindings: Env }>) {
  const daysRaw = c.req.query("days");
  const days = daysRaw === undefined ? 30 : Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return c.json({ error: "days must be an integer between 1 and 90" }, 400);
  }

  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  // 自造 cache key，不复用真实请求 URL，免得和受 Access 保护的路径响应混淆。
  const cacheKey = new Request(`https://cache.internal/x-usage?days=${days}`);

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      return new Response(hit.body, {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      });
    }
  }

  const res = await fetch(`${c.env.LINK_URL}/internal/x-usage?days=${days}`, {
    headers: { "X-Internal-Secret": c.env.INTERNAL_SECRET },
  });
  const text = await res.text();

  if (!res.ok) {
    console.error(JSON.stringify({
      event: "tms_x_usage_upstream_error",
      status: res.status,
      body: text.slice(0, 1000),
    }));
    return c.json({ error: "upstream_error", upstream_status: res.status }, 502);
  }

  if (cache) {
    await cache.put(
      cacheKey,
      new Response(text, {
        headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` },
      })
    );
  }

  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
  });
}
```

- [ ] **Step 4: 挂到 index.ts**

修改 `admin/src/index.ts`。在既有 import 区末尾（`import { SubscriptionDB } from "./services/subscription-db";` 之后）加：

```ts
import { accessAuth } from "./middleware/access-auth";
import { tmsXUsageRoute } from "./routes/tms-x-usage";
```

在 `app.post("/webhooks/stripe", webhookRoute);` 这一行**之后**加：

```ts
// TMS 管理控制台。第一道防线是 Cloudflare Access（边缘），accessAuth 是第二道。
// "/tms" 与 "/tms/*" 两条都要挂 —— Hono 的 "/tms/*" 不匹配裸 "/tms"，漏一条就是个洞。
app.use("/tms", accessAuth);
app.use("/tms/*", accessAuth);
app.get("/tms/api/x-usage", tmsXUsageRoute);
```

- [ ] **Step 5: 加 wrangler 变量**

修改 `admin/wrangler.toml`。在 `[env.dev.vars]` 块内已有三行之后追加：

```toml
LINK_URL = "https://link-dev.uni-scrm.com"
ACCESS_TEAM_DOMAIN = "billowing-brook-6d76.cloudflareaccess.com"
ACCESS_AUD_TAG = "72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b"
ADMIN_EMAILS = "zhengchao.qqqqq@gmail.com"
```

在 `[env.production.vars]` 块内已有两行之后追加：

```toml
LINK_URL = "https://link.uni-scrm.com"
ACCESS_TEAM_DOMAIN = "billowing-brook-6d76.cloudflareaccess.com"
ACCESS_AUD_TAG = "72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b"
ADMIN_EMAILS = "zhengchao.qqqqq@gmail.com"
```

production 的 `INTERNAL_SECRET` 已是 secret（见 `admin/.secrets.json`），dev 的已在 `[env.dev.vars]` 中明文，两者都不需要改动。

- [ ] **Step 6: 跑测试确认通过**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npx vitest run
npm run typecheck
```

Expected: 新增 7 个测试全 PASS，既有 admin 测试全部仍通过；typecheck 无错。

- [ ] **Step 7: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add admin/src/routes/tms-x-usage.ts admin/src/index.ts admin/wrangler.toml admin/tests/unit/tms-x-usage.test.ts
git commit -m "feat(admin): 新增 /tms/api/x-usage（10 分钟缓存，经 link 取数）"
```

---

### Task 5: 前端构建脚手架与 Worker 侧 SPA 资源服务

**Files:**
- Create: `admin/vite.config.ts`
- Create: `admin/frontend/index.html`
- Create: `admin/frontend/index.css`
- Create: `admin/frontend/main.tsx`
- Create: `admin/frontend/App.tsx`
- Modify: `admin/package.json`
- Modify: `admin/tsconfig.json`
- Modify: `admin/wrangler.toml`（加 `[assets]`）
- Modify: `admin/src/index.ts`（加 `serveTmsAsset`）

本任务的可验证成果：`npm run build` 产出 `admin/dist/`，部署后 `/tms` 返回 HTML 骨架，`/` 仍 404。页面内容在 Task 6。

**Interfaces:**
- Consumes: Task 3 挂好的 `accessAuth`（`serveTmsAsset` 位于其后）；Task 3 扩展的 `Env.ASSETS: Fetcher`
- Produces: `admin/frontend/App.tsx` 导出 `export function App(): JSX.Element`，Task 6 会替换其内容

- [ ] **Step 1: 加前端依赖与脚本**

修改 `admin/package.json`。`scripts` 整体替换为：

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "dev:worker": "wrangler dev --env dev --port 8792 --config wrangler.toml",
    "deploy:dev": "vite build --mode development && wrangler deploy --env dev --config wrangler.toml",
    "deploy:prod": "vite build && wrangler deploy --env production --config wrangler.toml",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
```

`deploy:dev` / `deploy:prod` 里的 `vite build` 不可省略：手敲 `wrangler deploy --env dev` 会跳过前端构建、发出过期的 dist。

`dependencies` 追加（保留已有的 `hono` 与 `stripe`）：

```json
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "recharts": "^3.9.0"
```

`devDependencies` 追加（保留已有各项）：

```json
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0"
```

然后：

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npm install
```

- [ ] **Step 2: 加 vite 配置**

新建 `admin/vite.config.ts`：

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "./frontend",
  // 页面挂在 /tms 下，产物里的资源引用必须带这个前缀。
  base: "/tms/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
});
```

- [ ] **Step 3: 更新 tsconfig**

`admin/tsconfig.json` 整体替换为：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types/2023-07-01"]
  },
  "include": ["src/**/*.ts", "frontend/**/*.ts", "frontend/**/*.tsx"],
  "exclude": ["node_modules", "dist"]
}
```

这与 `analytics/tsconfig.json` 的组合一致（DOM lib 与 workers-types 并存，已在该模块验证可行）。

- [ ] **Step 4: 建前端骨架**

新建 `admin/frontend/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>UniSCRM TMS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

`class="dark"` 直接写死在 `<html>` 上：管理控制台锁定暗色主题，不引 `shared/frontend/theme.ts`（那是租户向的、带 cookie 同步的主题切换）。

新建 `admin/frontend/index.css`：

```css
@import "tailwindcss";
@import "../../shared/frontend/index.css";
@source "../../shared/frontend";
```

新建 `admin/frontend/main.tsx`：

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

新建 `admin/frontend/App.tsx`（Task 6 会替换内容）：

```tsx
export function App() {
  return (
    <div className="min-h-screen bg-background text-foreground p-8">
      <h1 className="text-2xl font-semibold">UniSCRM TMS</h1>
    </div>
  );
}
```

- [ ] **Step 5: 加 [assets] 绑定**

修改 `admin/wrangler.toml`，在顶部 `compatibility_flags = ["nodejs_compat"]` 之后、`[observability]` 之前插入：

```toml
[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "none"
run_worker_first = true
```

`run_worker_first = true` 是本设计的默认安全属性：所有请求先进 Worker，静态资源只有在 Worker 显式调用 `ASSETS.fetch()` 时才被服务，不会自己从根路径漏出来。

- [ ] **Step 6: 实现 serveTmsAsset**

修改 `admin/src/index.ts`。在文件顶部的 import 之后、`const app = new Hono...` 之前加：

```ts
import type { Context } from "hono";

// vite 的 base "/tms/" 让产物里的引用变成 /tms/assets/xxx，而 dist 中的实际路径是
// /assets/xxx，所以转发给 ASSETS 之前必须把 /tms 前缀剥掉。
async function serveTmsAsset(c: Context<{ Bindings: Env }>) {
  const url = new URL(c.req.url);
  const stripped = url.pathname.replace(/^\/tms/, "") || "/";
  const assetRes = await c.env.ASSETS.fetch(new Request(new URL(stripped, url).toString(), { method: "GET" }));
  if (assetRes.status !== 404) return assetRes;
  // SPA 回退。走到这里说明 accessAuth 已经放行过了。
  return c.env.ASSETS.fetch(new Request(new URL("/index.html", url).toString(), { method: "GET" }));
}
```

在 Task 4 加的 `app.get("/tms/api/x-usage", tmsXUsageRoute);` 之后加：

```ts
app.get("/tms", serveTmsAsset);
app.get("/tms/*", serveTmsAsset);
```

顺序要紧：`/tms/api/x-usage` 必须注册在 `/tms/*` 之前，否则会被通配符吞掉。

- [ ] **Step 7: 构建并确认产物**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npm run build
ls dist
grep -o '/tms/assets/[^"]*' dist/index.html
```

Expected: `dist/index.html` 与 `dist/assets/` 存在；`grep` 输出形如 `/tms/assets/index-xxxxxxxx.js`（前缀必须是 `/tms/`，否则 `base` 没生效）。

- [ ] **Step 8: typecheck 与既有测试**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npm run typecheck
npx vitest run
```

Expected: 均通过。

- [ ] **Step 9: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add admin/vite.config.ts admin/tsconfig.json admin/package.json admin/package-lock.json admin/wrangler.toml admin/src/index.ts admin/frontend/index.html admin/frontend/index.css admin/frontend/main.tsx admin/frontend/App.tsx
git commit -m "feat(admin): 前端构建脚手架与 /tms 下的 SPA 资源服务"
```

`admin/dist/` 不要提交 —— 确认 `admin/` 或仓库根的 `.gitignore` 已忽略 `dist`；若没有，在 `admin/.gitignore` 里新建一行 `dist/` 并一并提交。

---

### Task 6: X 用量页面

**Files:**
- Create: `admin/frontend/pages/XUsage.tsx`
- Modify: `admin/frontend/App.tsx`

**Interfaces:**
- Consumes: Task 4 的 `GET /tms/api/x-usage?days=<7|30|90>`，200 时形如
  `{ data: { cap_reset_day: number; project_cap: number; project_id: string; project_usage: number; daily_project_usage?: { project_id: number; usage: { date: string; usage: number }[] }; daily_client_app_usage?: { client_app_id: string; usage_result_count: number; usage: { date: string; usage: number }[] }[] } }`，
  非 200 时形如 `{ error: string; upstream_status?: number }`
- Produces: `export function XUsage(): JSX.Element`

页面只调真实 API，**不加任何本地 mock 分支**。本地 `vite` 打开会渲染错误态 —— 这本身就顺便验证了错误态。样式细调时临时改 `fetchUsage` 的返回值即可，改完删掉，不要留在代码里。

- [ ] **Step 1: 写页面**

新建 `admin/frontend/pages/XUsage.tsx`：

```tsx
import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "../../../shared/frontend/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../shared/frontend/ui/card";
import { Progress } from "../../../shared/frontend/ui/progress";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../shared/frontend/ui/table";
import { Tabs, TabsList, TabsTrigger } from "../../../shared/frontend/ui/tabs";

interface UsageEntry {
  date: string;
  usage: number;
}

interface ClientAppUsage {
  client_app_id: string;
  usage_result_count: number;
  usage: UsageEntry[];
}

interface UsageData {
  cap_reset_day: number;
  project_cap: number;
  project_id: string;
  project_usage: number;
  daily_project_usage?: { project_id: number; usage: UsageEntry[] };
  daily_client_app_usage?: ClientAppUsage[];
}

interface ApiError {
  title: string;
  detail: string;
}

const DAY_OPTIONS = [7, 30, 90] as const;

function describeError(status: number, upstream?: number): ApiError {
  if (upstream === 401 || upstream === 403) {
    return {
      title: "X API 凭据无效",
      detail: "link worker 上的 X_BEARER_TOKEN 已失效或被轮换，需要重新 wrangler secret put。",
    };
  }
  if (upstream === 429) {
    return { title: "X API 限流", detail: "GET /2/usage/tweets 被限流，稍后再试。" };
  }
  if (status === 502) {
    return { title: "上游不可用", detail: `link worker 返回 ${upstream ?? "未知状态"}，检查 link 是否正常。` };
  }
  if (status === 403) {
    return { title: "无权访问", detail: "Access 会话可能已过期，刷新页面重新登录。" };
  }
  return { title: "请求失败", detail: `HTTP ${status}` };
}

async function fetchUsage(days: number): Promise<UsageData> {
  const res = await fetch(`/tms/api/x-usage?days=${days}`);
  if (!res.ok) {
    let upstream: number | undefined;
    try {
      upstream = ((await res.json()) as { upstream_status?: number }).upstream_status;
    } catch {
      upstream = undefined;
    }
    const e = describeError(res.status, upstream);
    throw Object.assign(new Error(e.title), e);
  }
  return ((await res.json()) as { data: UsageData }).data;
}

function formatDay(iso: string): string {
  return iso.slice(5, 10);
}

export function XUsage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsage(days)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: ApiError) => {
        if (!cancelled) {
          setData(null);
          setError({ title: err.title ?? "请求失败", detail: err.detail ?? String(err) });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const cap = Number(data?.project_cap ?? 0);
  const used = Number(data?.project_usage ?? 0);
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const trend = (data?.daily_project_usage?.usage ?? []).map((u) => ({
    day: formatDay(u.date),
    usage: Number(u.usage),
  }));
  const apps = (data?.daily_client_app_usage ?? []).map((a) => ({
    id: a.client_app_id,
    total: a.usage.reduce((sum, u) => sum + Number(u.usage), 0),
    dayCount: a.usage.length,
  }));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl space-y-6 p-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">X API 平台用量</h1>
            <p className="text-sm text-muted-foreground">
              来自 X 的 GET /2/usage/tweets，整个 project 维度，非单租户
            </p>
          </div>
          <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <TabsList>
              {DAY_OPTIONS.map((d) => (
                <TabsTrigger key={d} value={String(d)}>
                  {d} 天
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error.title}</AlertTitle>
            <AlertDescription>{error.detail}</AlertDescription>
          </Alert>
        )}

        {loading && <Skeleton className="h-40 w-full" />}

        {!loading && data && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>本周期用量</CardTitle>
                <CardDescription>
                  project {data.project_id} · 每月 {data.cap_reset_day} 日重置
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-3xl font-semibold">{used.toLocaleString()}</span>
                  <span className="text-sm text-muted-foreground">
                    / {cap.toLocaleString()} ({pct.toFixed(1)}%)
                  </span>
                </div>
                <Progress value={pct} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>每日用量</CardTitle>
                <CardDescription>最近 {days} 天</CardDescription>
              </CardHeader>
              <CardContent>
                {trend.length === 0 ? (
                  <p className="text-sm text-muted-foreground">该区间内没有用量记录。</p>
                ) : (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={trend}>
                        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                        <XAxis dataKey="day" stroke="var(--color-muted-foreground)" fontSize={12} />
                        <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
                        <Tooltip
                          contentStyle={{
                            background: "var(--color-card)",
                            border: "1px solid var(--color-border)",
                            color: "var(--color-foreground)",
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="usage"
                          stroke="var(--color-primary)"
                          fill="var(--color-primary)"
                          fillOpacity={0.2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>按 client app 分解</CardTitle>
                <CardDescription>同一 project 下各 app 在最近 {days} 天的合计</CardDescription>
              </CardHeader>
              <CardContent>
                {apps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">X 未返回 client app 明细。</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client App ID</TableHead>
                        <TableHead className="text-right">合计用量</TableHead>
                        <TableHead className="text-right">有记录天数</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {apps.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell className="font-mono text-xs">{a.id}</TableCell>
                          <TableCell className="text-right">{a.total.toLocaleString()}</TableCell>
                          <TableCell className="text-right">{a.dayCount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 接进 App**

`admin/frontend/App.tsx` 整体替换为：

```tsx
import { XUsage } from "./pages/XUsage";

export function App() {
  return <XUsage />;
}
```

单页应用，不引 react-router。

- [ ] **Step 3: 构建并 typecheck**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npm run build
npm run typecheck
```

Expected: 构建成功；typecheck 无错。

页面用到的五个 token —— `--color-foreground`、`--color-muted-foreground`、`--color-border`、`--color-primary`、`--color-card` —— 均已确认存在于 `shared/frontend/index.css` 的 `.dark` 块（第 42 行起）。不得引入任何写死的 hex。

- [ ] **Step 4: Commit**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web
git add admin/frontend/pages/XUsage.tsx admin/frontend/App.tsx
git commit -m "feat(admin): TMS X API 用量页面（总量卡 / 日趋势 / client app 分解）"
```

---

### Task 7: 部署 dev 并在浏览器中自测

**Files:** 无代码改动（除非自测发现问题）

**Interfaces:**
- Consumes: 前六个任务的全部产出

- [ ] **Step 1: 部署 link dev**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link
npm run deploy:dev
```

Expected: 部署成功。link 是 `/internal/x-usage` 的提供方，必须先于 admin 上线。

- [ ] **Step 2: 部署 admin dev**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin
npm run deploy:dev
```

Expected: 先 `vite build` 再 `wrangler deploy --env dev`，输出里能看到上传了 assets。

- [ ] **Step 3: 命令行核对边界没被破坏**

```bash
for u in "https://admin-dev.uni-scrm.com/health" "https://admin-dev.uni-scrm.com/" "https://admin-dev.uni-scrm.com/tms" "https://admin-dev.uni-scrm.com/tms/api/x-usage"; do
  printf "%-52s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$u")"
done
```

Expected：`/health` = 200；`/` = 404（assets 绝不能从根路径漏出来 —— 若这里返回 200 且是 HTML，说明 `run_worker_first` 或路由写错了，必须先修）；`/tms` = 302（Access 拦截）；`/tms/api/x-usage` = 302。

- [ ] **Step 4: 浏览器自测**

用 Chrome 浏览器工具打开 `https://admin-dev.uni-scrm.com/tms`。逐项确认：

1. 被跳到 `billowing-brook-6d76.cloudflareaccess.com` 的登录页，提示发送一次性验证码到邮箱
2. 用 `zhengchao.qqqqq@gmail.com` 收码登录后，跳回 `/tms` 并渲染出页面
3. 「本周期用量」卡显示了真实的已用/上限数字和百分比进度条，重置日是个 1–31 的整数
4. 「每日用量」面积图有数据点，横轴是 `MM-DD`
5. 「按 client app 分解」表格有行，或显示「X 未返回 client app 明细」
6. 切换 7 / 30 / 90 天，图表跟着变；同一档位第二次切回来是秒开（走了 10 分钟缓存）
7. DevTools Network 里 `/tms/api/x-usage` 首次响应头 `X-Cache: MISS`，重复请求为 `HIT`
8. 页面是暗色的，配色与产品一致，没有跑出紫色主色调之外的色相

- [ ] **Step 5: 验证租户会话进不来**

在同一浏览器里，用已登录租户 SaaS 的另一个标签页（有 `session` cookie，domain 是 `uni-scrm.com`）访问 `https://admin-dev.uni-scrm.com/tms`。

Expected: 仍被 Access 拦到登录页 —— 租户 cookie 对 `/tms` 没有任何作用。

若手上的浏览器已经过了 Access 登录，用无痕窗口重试；无痕窗口里既没有 Access 会话也没有租户会话，应当直接跳登录页。

- [ ] **Step 6: 跑全量测试**

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin && npx vitest run && npm run typecheck
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npx vitest run && npm run typecheck
```

Expected: 全部通过。

- [ ] **Step 7: 记录结果**

把 Step 4 的逐项结果与 Step 3 的状态码表贴给用户。**不要自行部署 production** —— 那要用户明确点头。prod 部署时的命令是：

```bash
cd /Users/zc/Documents/UniSCRM/uniscrm-web/link && npm run deploy:prod
cd /Users/zc/Documents/UniSCRM/uniscrm-web/admin && npm run deploy:prod
```

---

## 附：本设计刻意不做的事

- 不加"本地跳过 Access"的开关。本地 `wrangler dev` 下 `/tms/*` 一律 403 是预期行为。
- 不落库。X 自身即返回最近 90 天日粒度，90 天内落库是纯冗余。将来要更长的历史再加 cron 快照。
- 不引 `Nav` / `Sidebar` / `TierGuard` / `useTier`。那些是租户向组件，会读 tier cookie。
- 不做多管理员、角色、审计日志。当前只有一名运营方，Access 的邮箱白名单已经够了。
- 没有异步队列、没有 `_status` 字段，因此不生成 `sequence.md` / `status.md`。

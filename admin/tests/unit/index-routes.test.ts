import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../../src/index";
import type { AccessJwk } from "../../src/lib/jwt";

// 这个测试碰的是 src/index.ts 里真实的路由表，不是像 access-auth.test.ts / tms-x-usage.test.ts
// 那样各自手搭的隔离 Hono 实例。目的是钉死注册顺序这个不变量：
// app.get("/tms/api/x-usage", ...) 必须在 app.get("/tms/*", serveTmsAsset) 之前，
// 否则通配符会吞掉 API 路由、让 API 返回 HTML 而不是 JSON。

const TEAM = "billowing-brook-6d76.cloudflareaccess.com";
const AUD = "72723d319f12e151dd364f9185e93f82717ba42f567d3b0a7a90926d2d16321b";
const KID = "test-kid-1";
const OWNER = "zhengchao.qqqqq@gmail.com";

// 与 access-auth.test.ts 里的 helper 逐字重复 —— 项目负责人裁定保留的惯例，不抽共享文件。
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

const baseEnv = {
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD_TAG: AUD,
  ADMIN_EMAILS: OWNER,
  LINK_URL: "https://link-dev.uni-scrm.com",
  INTERNAL_SECRET: "dev-internal-secret",
};

function makeAssets() {
  return { fetch: vi.fn(async () => new Response("<html>SPA</html>", { headers: { "Content-Type": "text/html" } })) };
}

// Node 下没有全局 caches，tms-x-usage.ts 会走无缓存分支；显式 stub 让行为确定，不依赖运行环境。
function stubCaches() {
  vi.stubGlobal("caches", { default: { match: vi.fn().mockResolvedValue(undefined), put: vi.fn().mockResolvedValue(undefined) } });
}

function stubFetch(jwk: AccessJwk) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/cdn-cgi/access/certs")) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url.includes("/internal/x-usage")) {
        return new Response(JSON.stringify({ data: { project_usage: 1 } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("src/index.ts real route table", () => {
  it("does not let /tms/* swallow /tms/api/x-usage — API stays JSON, ASSETS never touched", async () => {
    const { privateKey, jwk } = await makeKeys();
    stubFetch(jwk);
    stubCaches();
    const assets = makeAssets();

    const res = await worker.fetch(
      new Request("https://admin.uni-scrm.com/tms/api/x-usage", {
        headers: { "Cf-Access-Jwt-Assertion": await signToken(privateKey, OWNER) },
      }),
      { ...baseEnv, ASSETS: assets } as never
    );

    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("serves the SPA shell through ASSETS for bare /tms", async () => {
    const { privateKey, jwk } = await makeKeys();
    stubFetch(jwk);
    stubCaches();
    const assets = makeAssets();

    const res = await worker.fetch(
      new Request("https://admin.uni-scrm.com/tms", {
        headers: { "Cf-Access-Jwt-Assertion": await signToken(privateKey, OWNER) },
      }),
      { ...baseEnv, ASSETS: assets } as never
    );

    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toBe("<html>SPA</html>");
    expect(assets.fetch).toHaveBeenCalled();
  });

  // 核心安全不变量：accessAuth 必须先于 serveTmsAsset 跑，且必须挡住 ASSETS.fetch 本身
  // 被调用。如果将来有人把 app.use("/tms/*", accessAuth) 挪到 handler 注册之后（hono 里
  // use 晚于 handler 注册即不生效），这两条会立刻从绿变红；此前的用例全带合法 token，
  // 挪动注册顺序时全部继续通过，测不出这个洞。
  it("rejects bare /tms with no Access JWT and never touches ASSETS", async () => {
    const assets = makeAssets();

    const res = await worker.fetch(
      new Request("https://admin.uni-scrm.com/tms"),
      { ...baseEnv, ASSETS: assets } as never
    );

    expect(res.status).toBe(403);
    expect(assets.fetch).not.toHaveBeenCalled();
  });

  it("rejects a /tms/assets/* static asset request with no Access JWT and never touches ASSETS", async () => {
    const assets = makeAssets();

    const res = await worker.fetch(
      new Request("https://admin.uni-scrm.com/tms/assets/index-abc.js"),
      { ...baseEnv, ASSETS: assets } as never
    );

    expect(res.status).toBe(403);
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});

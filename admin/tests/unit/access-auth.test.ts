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
  app.use("/tms/*", accessAuth as never);
  app.get("/tms", (c) => c.json({ ok: true, email: c.get("adminEmail" as never) }));
  app.get("/tms/api/x-usage", (c) => c.json({ ok: true }));
  return app;
}

function stubJwks(jwk: AccessJwk) {
  const fetchMock = vi.fn().mockImplementation(
    async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
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

  // 钉死"每个请求只跑一遍"：/tms 只挂了一条 "/tms/*" 中间件，裸路径请求不该
  // 触发重复验证 / 重复拉取 JWKS。
  it("runs the middleware exactly once per request for the bare /tms path", async () => {
    const { privateKey, jwk } = await makeKeys();
    const fetchMock = stubJwks(jwk);
    const res = await makeApp().request(
      "/tms",
      { headers: { "Cf-Access-Jwt-Assertion": await signToken(privateKey, OWNER) } },
      fullEnv
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

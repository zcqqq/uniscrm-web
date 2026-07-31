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

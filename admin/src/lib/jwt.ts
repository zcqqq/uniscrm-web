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
  nbf?: number;
}

const JWKS_TTL_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 60;

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
      // 加了 DOM lib 后 BufferSource 要求 ArrayBuffer 而非 ArrayBufferLike，纯 TS 类型层面的
      // 分歧（这里的字节确实来自 ArrayBuffer，非 SharedArrayBuffer），断言不改变运行时行为。
      base64UrlToBytes(signatureB64) as BufferSource,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;

  // nbf/iat 只在存在且明显指向未来时才拒绝。留 60 秒容差：Worker 与 Cloudflare
  // 之间的时钟偏差不该把合法用户挡在门外。
  if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_SECONDS) return null;
  if (typeof payload.iat === "number" && payload.iat > now + CLOCK_SKEW_SECONDS) return null;

  if (payload.iss !== `https://${opts.teamDomain}`) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.audTag)) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;

  return payload;
}

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

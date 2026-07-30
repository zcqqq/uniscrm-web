// member 密码的哈希与校验。
//
// 用 node:crypto 的 scrypt（`nodejs_compat` 已在 wrangler.toml 中开启）。这里**不能**用
// WebCrypto 的 PBKDF2：线上 Workers 拒绝迭代数超过 100000 的 PBKDF2，直接抛
// NotSupportedError，而本地 workerd 不执行这条限制——本模块的单测曾因此在 600000 迭代下全绿，
// 直到部署 web-dev 才发现两条新路由在线上恒定 500。
//
// 被压到 100000 并不只是"少一点强度"：PBKDF2 需要高迭代数，正是因为它在 GPU 上极易并行，封顶
// 等于把这个弱点放大。scrypt 的抵抗力来自内存占用而不是迭代次数，正好绕开这个封顶。
//
// N=16384/r=8/p=1 每次哈希约占 16MB（128*N*r）。Workers 单实例内存上限 128MB，所以这个取值
// 在并发登录时仍留有余量；线上实测 N=32768（32MB）同样可用，将来要提高强度有空间。
//
// 编码串自带参数：
//   scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>
// 校验时读的是串里携带的参数而非下面的常量，所以日后调参既不用改表也不用做数据迁移——老串照样
// 验证通过，再由 needsUpgrade 触发就地重算。

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const CURRENT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const SALT_BYTES = 16;
const HASH_BYTES = 32;
// 128 * N * r 是 scrypt 的内存开销；给足两倍余量，避免 node 默认 32MB 上限在调参后突然拦下来。
const MAXMEM = 128 * 1024 * 1024;

export interface ParsedHash extends ScryptParams {
  salt: Buffer;
  hash: Buffer;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Buffer {
  return scryptSync(password, salt, HASH_BYTES, { ...params, maxmem: MAXMEM });
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

export async function hashPassword(password: string, params: ScryptParams = CURRENT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = derive(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 6) return null;
  const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (scheme !== "scrypt") return null;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  // N 必须是大于 1 的 2 的幂，否则 scryptSync 会抛；r/p 必须是正整数。
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) return null;
  try {
    const salt = Buffer.from(saltRaw, "base64");
    const hash = Buffer.from(hashRaw, "base64");
    if (salt.length === 0 || hash.length === 0) return null;
    return { N, r, p, salt, hash };
  } catch {
    return null;
  }
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  let candidate: Buffer;
  try {
    candidate = derive(password, parsed.salt, parsed);
  } catch {
    // 参数虽然通过了校验，但仍可能超出 maxmem 之类的运行时限制；此时按验证失败处理，不要把异常
    // 抛给调用方——那会让一个畸形的库内行把整条登录路由变成 500。
    return false;
  }
  // node 的 timingSafeEqual 对长度不等的输入会直接抛异常，必须先自己挡住。
  if (candidate.length !== parsed.hash.length) return false;
  return timingSafeEqual(candidate, parsed.hash);
}

// 给「查无此人」和「这个 member 从没设过密码」两种情况烧掉与真实校验等量的 CPU。少了这一步，
// 「这个邮箱 2ms 就返回，那个要几十毫秒」本身就是一台 member 表的枚举器。
export async function dummyVerify(password: string): Promise<void> {
  derive(password, Buffer.alloc(SALT_BYTES), CURRENT_PARAMS);
}

// 只在参数确实弱于当前标准时才要求升级；更强的参数（例如手工调高过 N 的行）不该被降回来。
export function needsUpgrade(encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  return parsed.N < CURRENT_PARAMS.N || parsed.r < CURRENT_PARAMS.r || parsed.p < CURRENT_PARAMS.p;
}

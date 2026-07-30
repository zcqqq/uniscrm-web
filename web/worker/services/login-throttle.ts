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

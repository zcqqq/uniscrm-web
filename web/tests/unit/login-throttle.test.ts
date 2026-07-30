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

import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  parseHash,
  needsUpgrade,
  validatePassword,
  CURRENT_PARAMS,
} from "../../worker/services/password";

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
    expect(encoded.startsWith(`scrypt$${CURRENT_PARAMS.N}$${CURRENT_PARAMS.r}$${CURRENT_PARAMS.p}$`)).toBe(true);
  });

  // 参数内联的意义：按串里携带的参数验证，而不是按代码里的常量
  it("能验证用更弱参数存下来的旧串", async () => {
    const weak = await hashPassword("legacy secret", { N: 1024, r: 8, p: 1 });
    expect(await verifyPassword("legacy secret", weak)).toBe(true);
  });
});

describe("parseHash", () => {
  it("畸形串一律返回 null 且不抛异常", () => {
    const bad = [
      "",
      "not-a-hash",
      "scrypt$16384$8$1$onlyfive",
      "pbkdf2$sha256$600000$c2FsdA==$aGFzaA==",
      "scrypt$abc$8$1$c2FsdA==$aGFzaA==",
      "scrypt$0$8$1$c2FsdA==$aGFzaA==",
      "scrypt$16384$8$1$!!!$aGFzaA==",
    ];
    for (const s of bad) expect(parseHash(s)).toBeNull();
  });
});

describe("verifyPassword 遇到畸形的库内串", () => {
  it("返回 false 而不是抛异常", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });

  // scrypt 的 timingSafeEqual 对长度不等的输入会抛，必须自己先挡住
  it("哈希段长度异常时也返回 false 而不是抛异常", async () => {
    expect(await verifyPassword("anything", "scrypt$16384$8$1$c2FsdHNhbHRzYWx0c2Ex$c2hvcnQ=")).toBe(false);
  });
});

describe("needsUpgrade", () => {
  it("弱于当前参数的串被标记为需要升级", async () => {
    expect(needsUpgrade(await hashPassword("x", { N: 1024, r: 8, p: 1 }))).toBe(true);
  });

  it("当前参数的串不需要升级", async () => {
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

import { describe, it, expect } from "vitest";
import { normalizeEmail } from "../../worker/services/email-identity";

describe("normalizeEmail", () => {
  it("小写化", () => {
    expect(normalizeEmail("Zhengchao.QQQQQ@Gmail.com")).toBe("zhengchao.qqqqq@gmail.com");
  });

  it("去掉首尾空格", () => {
    expect(normalizeEmail("  a@example.com  ")).toBe("a@example.com");
  });

  it("已经是规范形式时原样返回", () => {
    expect(normalizeEmail("a@example.com")).toBe("a@example.com");
  });
});

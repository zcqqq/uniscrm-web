import { describe, it, expect } from "vitest";
import { resolveSignupLanguage } from "../../worker/services/language";

// 注册时写一次 members.language，之后决定整个产品对这个人显示什么语言。信号是浏览器的
// Accept-Language 头。参见 worker/services/language.ts 顶部的背景说明。
describe("resolveSignupLanguage", () => {
  it("picks zh for a Chinese browser", () => {
    expect(resolveSignupLanguage("zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh");
  });

  it("picks en for an English browser", () => {
    expect(resolveSignupLanguage("en-US,en;q=0.9")).toBe("en");
  });

  it("honours q-values over header order", () => {
    // 头里 en 在前，但 zh 的权重更高 —— 用户更想要中文。
    expect(resolveSignupLanguage("en;q=0.5,zh-CN;q=0.9")).toBe("zh");
  });

  it("keeps header order when q-values tie", () => {
    expect(resolveSignupLanguage("en,zh")).toBe("en");
    expect(resolveSignupLanguage("zh,en")).toBe("zh");
  });

  it("maps every Chinese variant to zh (we only ship Simplified, still better than English)", () => {
    expect(resolveSignupLanguage("zh-TW")).toBe("zh");
    expect(resolveSignupLanguage("zh-Hant-HK")).toBe("zh");
    expect(resolveSignupLanguage("ZH-cn")).toBe("zh");
  });

  it("skips languages we do not ship and falls through to a supported one", () => {
    // 日语排最前，但我们没有日文；下一个受支持的是中文，好过直接给英文。
    expect(resolveSignupLanguage("ja,zh-CN;q=0.8,en;q=0.5")).toBe("zh");
    expect(resolveSignupLanguage("fr-FR,de;q=0.9")).toBe("en");
  });

  it("ignores tags explicitly refused with q=0", () => {
    expect(resolveSignupLanguage("zh;q=0,en")).toBe("en");
  });

  it("falls back to en when the header is missing, empty or a wildcard", () => {
    expect(resolveSignupLanguage(undefined)).toBe("en");
    expect(resolveSignupLanguage(null)).toBe("en");
    expect(resolveSignupLanguage("")).toBe("en");
    expect(resolveSignupLanguage("*")).toBe("en");
  });

  it("does not throw on a malformed header", () => {
    expect(resolveSignupLanguage(";;;")).toBe("en");
    expect(resolveSignupLanguage("zh;q=abc,en;q=0.5")).toBe("en");
  });
});

import { describe, it, expect } from "vitest";
import { localeFromCookie } from "../../../shared/frontend/hooks/useLocale";

// 语言原本只能靠异步 fetch(/api/auth/me) 拿到，于是每个页面都会先渲染一遍英文再跳成中文。
// lang cookie 在登录时就由 web worker 落好了（domain=uni-scrm.com，全模块可读），
// 同步可得——拿它做初值，闪烁就没了。
describe("localeFromCookie", () => {
  it("读出 zh", () => {
    expect(localeFromCookie("lang=zh")).toBe("zh");
  });

  it("读出 en", () => {
    expect(localeFromCookie("lang=en")).toBe("en");
  });

  it("cookie 串里有其它项也能读到", () => {
    expect(localeFromCookie("theme=dark; lang=zh; sidebar=expanded")).toBe("zh");
  });

  // 不能把 "language=xx" 之类的前缀误当成 lang
  it("不匹配名字仅仅以 lang 结尾或开头的 cookie", () => {
    expect(localeFromCookie("mylang=zh")).toBeNull();
    expect(localeFromCookie("language=zh")).toBeNull();
  });

  it("没有该 cookie 时返回 null，交给调用方决定默认值", () => {
    expect(localeFromCookie("")).toBeNull();
    expect(localeFromCookie("theme=dark")).toBeNull();
  });

  // 值不在枚举内时按「没读到」处理，绝不把脏值当 locale 传下去
  it("无法识别的值返回 null", () => {
    expect(localeFromCookie("lang=fr")).toBeNull();
    expect(localeFromCookie("lang=")).toBeNull();
  });
});

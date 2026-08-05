import { describe, it, expect } from "vitest";
import { C } from "../../../shared/frontend/i18n-common";

describe("共享词表 C", () => {
  it("每个词条的 en 与 zh 都非空", () => {
    for (const [key, value] of Object.entries(C)) {
      expect(value.en, `${key}.en 为空`).toBeTruthy();
      expect(value.zh, `${key}.zh 为空`).toBeTruthy();
    }
  });

  // 词表的意义是「同一个词全站一种译法」。两个 key 映射到同一个中文词，
  // 说明词表本身有重复项，调用处就会开始纠结该用哪个。
  it("中文译法不重复", () => {
    const zh = Object.values(C).map((v) => v.zh);
    expect(new Set(zh).size).toBe(zh.length);
  });

  it("覆盖了实际高频词", () => {
    for (const key of ["save", "cancel", "delete", "edit", "loading", "confirm", "search"]) {
      expect(C, `词表缺 ${key}`).toHaveProperty(key);
    }
  });
});

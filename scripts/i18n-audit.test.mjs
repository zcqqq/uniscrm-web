import { describe, it, expect } from "vitest";
import { findHardcoded, isExempted } from "./i18n-audit.mjs";

describe("findHardcoded", () => {
  it("抓出 JSX 文本节点里的英文句子", () => {
    const src = `export function A() { return <Button>Save changes</Button>; }`;
    expect(findHardcoded(src, "a.tsx")).toHaveLength(1);
  });

  it("抓出 placeholder 与 title 属性", () => {
    const src = `<Input placeholder="Enter your email" title="Email address" />`;
    expect(findHardcoded(src, "a.tsx").length).toBeGreaterThanOrEqual(2);
  });

  // 已经翻好的不能再报，否则脚本永远不会变绿
  it("不报已经写成双语对象的文案", () => {
    const src = `<Button>{T({ en: "Save changes", zh: "保存修改" })}</Button>`;
    expect(findHardcoded(src, "a.tsx")).toHaveLength(0);
  });

  it("不报单个单词的技术标识", () => {
    const src = `<div className="flex items-center gap-2" data-testid="row" />`;
    expect(findHardcoded(src, "a.tsx")).toHaveLength(0);
  });

  // 菜单项与列名大量是单个大写词，漏掉它们等于漏掉侧边栏和所有表头
  it("抓出单个词的标题", () => {
    expect(findHardcoded(`<h1>Dashboard</h1>`, "a.tsx")).toHaveLength(1);
  });

  // 这条守的是引号配对：同行先出现一个短串时，长度下限写成 {3,} 会让正则
  // 从错误位置继续，把后面真正的文案整个跳过
  it("同一行里短串在前时，后面的文案仍能抓到", () => {
    const src = `const opts = [{ value: "a", label: "Last 7 days" }];`;
    expect(findHardcoded(src, "a.tsx")).toHaveLength(1);
  });

  it("抓出对象里的列名", () => {
    const src = `const cols = [{ key: "n", header: "Total events" }];`;
    expect(findHardcoded(src, "a.tsx")).toHaveLength(1);
  });

  it("抓出三元表达式两侧的文案", () => {
    expect(findHardcoded(`{loading ? "Loading data" : "No data found"}`, "a.tsx")).toHaveLength(2);
  });

  it("抓出变量赋值里的文案", () => {
    expect(findHardcoded(`const emptyText = "No channels connected yet";`, "a.tsx")).toHaveLength(1);
  });

  it("不报短标识串", () => {
    expect(findHardcoded(`const a = "ok"; const b = "id";`, "a.tsx")).toHaveLength(0);
  });

  it("不报 import 路径与 URL", () => {
    const src = `import { Button } from "../ui/button";\nconst u = "https://example.com/a/b";`;
    expect(findHardcoded(src, "a.tsx")).toHaveLength(0);
  });

  it("抓出原生 confirm 的提示语", () => {
    const src = `if (confirm("Delete this segment?")) remove();`;
    expect(findHardcoded(src, "a.tsx")).toHaveLength(1);
  });
});

describe("isExempted", () => {
  it("同一行的 i18n-ok 注释生效", () => {
    const src = `const x = "Internal debug label"; // i18n-ok: 只进日志`;
    expect(isExempted(src, 1)).toBe(true);
  });

  it("上一行的 i18n-ok 注释生效", () => {
    const src = `// i18n-ok: 只进日志\nconst x = "Internal debug label";`;
    expect(isExempted(src, 2)).toBe(true);
  });

  // 光写 i18n-ok 不给理由不算数——豁免必须留下原因，否则它就成了万能消音器
  it("没写理由的 i18n-ok 不生效", () => {
    const src = `const x = "Internal debug label"; // i18n-ok:`;
    expect(isExempted(src, 1)).toBe(false);
  });

  it("没有注释时不豁免", () => {
    const src = `const x = "Internal debug label";`;
    expect(isExempted(src, 1)).toBe(false);
  });
});

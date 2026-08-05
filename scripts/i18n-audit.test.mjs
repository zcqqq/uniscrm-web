import { test } from "node:test";
import assert from "node:assert/strict";
import { findHardcoded, isExempted } from "./i18n-audit.mjs";

test("findHardcoded: 抓出 JSX 文本节点里的英文句子", () => {
  const src = `export function A() { return <Button>Save changes</Button>; }`;
  assert.equal(findHardcoded(src, "a.tsx").length, 1);
});

test("findHardcoded: 抓出 placeholder 与 title 属性", () => {
  const src = `<Input placeholder="Enter your email" title="Email address" />`;
  assert.ok(findHardcoded(src, "a.tsx").length >= 2);
});

// 已经翻好的不能再报，否则脚本永远不会变绿
test("findHardcoded: 不报已经写成双语对象的文案", () => {
  const src = `<Button>{T({ en: "Save changes", zh: "保存修改" })}</Button>`;
  assert.equal(findHardcoded(src, "a.tsx").length, 0);
});

test("findHardcoded: 不报单个单词的技术标识", () => {
  const src = `<div className="flex items-center gap-2" data-testid="row" />`;
  assert.equal(findHardcoded(src, "a.tsx").length, 0);
});

// 菜单项与列名大量是单个大写词，漏掉它们等于漏掉侧边栏和所有表头
test("findHardcoded: 抓出单个词的标题", () => {
  assert.equal(findHardcoded(`<h1>Dashboard</h1>`, "a.tsx").length, 1);
});

// 这条守的是引号配对：同行先出现一个短串时，长度下限写成 {3,} 会让正则
// 从错误位置继续，把后面真正的文案整个跳过
test("findHardcoded: 同一行里短串在前时，后面的文案仍能抓到", () => {
  const src = `const opts = [{ value: "a", label: "Last 7 days" }];`;
  assert.equal(findHardcoded(src, "a.tsx").length, 1);
});

test("findHardcoded: 抓出对象里的列名", () => {
  const src = `const cols = [{ key: "n", header: "Total events" }];`;
  assert.equal(findHardcoded(src, "a.tsx").length, 1);
});

test("findHardcoded: 抓出三元表达式两侧的文案", () => {
  assert.equal(findHardcoded(`{loading ? "Loading data" : "No data found"}`, "a.tsx").length, 2);
});

test("findHardcoded: 抓出变量赋值里的文案", () => {
  assert.equal(findHardcoded(`const emptyText = "No channels connected yet";`, "a.tsx").length, 1);
});

test("findHardcoded: 不报短标识串", () => {
  assert.equal(findHardcoded(`const a = "ok"; const b = "id";`, "a.tsx").length, 0);
});

test("findHardcoded: 不报 import 路径与 URL", () => {
  const src = `import { Button } from "../ui/button";\nconst u = "https://example.com/a/b";`;
  assert.equal(findHardcoded(src, "a.tsx").length, 0);
});

test("findHardcoded: 抓出原生 confirm 的提示语", () => {
  const src = `if (confirm("Delete this segment?")) remove();`;
  assert.equal(findHardcoded(src, "a.tsx").length, 1);
});

test("isExempted: 同一行的 i18n-ok 注释生效", () => {
  const src = `const x = "Internal debug label"; // i18n-ok: 只进日志`;
  assert.equal(isExempted(src, 1), true);
});

test("isExempted: 上一行的 i18n-ok 注释生效", () => {
  const src = `// i18n-ok: 只进日志\nconst x = "Internal debug label";`;
  assert.equal(isExempted(src, 2), true);
});

// 光写 i18n-ok 不给理由不算数——豁免必须留下原因，否则它就成了万能消音器
test("isExempted: 没写理由的 i18n-ok 不生效", () => {
  const src = `const x = "Internal debug label"; // i18n-ok:`;
  assert.equal(isExempted(src, 1), false);
});

test("isExempted: 没有注释时不豁免", () => {
  const src = `const x = "Internal debug label";`;
  assert.equal(isExempted(src, 1), false);
});

# 全系统前端 UI 文案中文化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 7 个前端模块里全部用户可见的硬编码英文接入双语，中文语言下全站显示中文。

**Architecture:** 用内联双语串——`{ en, zh }` 对象写在使用处，经 `metadata/locale.ts` 既有的 `t(s, locale)` 渲染。新增 `useT()` hook 把 locale 绑定收进一次调用。退役 i18next，全系统只剩这一种机制。高频词收进 shared 词表，其余一律内联。

**Tech Stack:** React + TypeScript + Vite，7 个独立 Cloudflare Worker/SPA，vitest + @cloudflare/vitest-pool-workers。

## Global Constraints

- 仓库根 `/Users/zc/Documents/UniSCRM/uniscrm-web`。**git 命令在仓库根执行；npm / vitest / tsc / vite / wrangler 命令在对应模块目录执行**（如 `web/`、`flow/`）。
- `LocalizedString` 的定义是 `{ en: string; zh: string }`（`metadata/dataTypes.ts:12`），**两个字段都必填**——漏写 zh 是编译错误，不是运行时回落。
- `metadata/locale.ts` 的 `t(s, locale)` 与 `Locale` 类型**保持原样，不得修改**。
- 前端不用 inline CSS，复用 `shared/frontend/ui/` 既有组件。
- **禁改文件**：`flow/nodeTypeRegistry.ts`、整个 `uniscrm-web/metadata/` 目录（deny 名单）。
- 一律用全局 `wrangler`，不要 `npx wrangler`。部署 dev 用 `npm run deploy:dev`。
- 不要 `git stash`，不要让文件跨工具调用停留在暂存区——本仓库有并发 session，暂存区共享。`git add` 与 `git commit` 必须在同一条命令里完成。
- 除非用户明确说 push to main，否则只在本地提交，不要 push。
- **不动的东西**：日期格式（`shared/frontend/lib/format-time.ts` 刻意固定，有 `scripts/time-format-audit.mjs` 把关）；`metadata/*.ts`（已双语）；`admin/`（内部工具，已是中文）；后端 `c.json({error:...})`；邮件模板；各模块 `index.html` 的 `<title>`。

### 术语表（所有翻译任务逐字遵守）

| en | zh | | en | zh |
|---|---|---|---|---|
| Channel | 渠道 | | Segment | 分群 |
| Flow | 流程 | | List | 名单 |
| Trigger | 触发器 | | Tier / Plan | 套餐 |
| Action | 动作 | | Credit | 额度 |
| Condition | 条件 | | Publish | 发布 |
| Node | 节点 | | Draft | 草稿 |
| Member | 成员 | | Subscription | 订阅 |
| User（渠道账号） | 用户 | | Connect / Disconnect | 连接 / 断开 |
| Recommendation | 推荐 | | Sync | 同步 |
| Content Library | 内容库 | | Upgrade | 升级 |
| Dashboard | 仪表盘 | | Webhook / API / OAuth | 保留英文 |

**保留英文不译**：UniSCRM、X、YouTube、TikTok、Shopify、Notion、Stripe、Webhook、API、OAuth、BYOK、Cron、A/B、URL、ID、Token。

**风格**：简体中文；中英文之间加半角空格（"连接 X 渠道"）；标点全角；陈述句不用敬语；按钮文案动词开头且简短。

---

### Task 1: 翻译机制（useT + 共享词表 + useLocale 消闪烁）

后续 12 个翻译任务全部依赖这个任务的产物，必须先做完。

**Files:**
- Create: `shared/frontend/hooks/useT.ts`
- Create: `shared/frontend/i18n-common.ts`
- Modify: `shared/frontend/hooks/useLocale.ts`
- Test: `web/tests/unit/i18n-common.test.ts`、`web/tests/unit/use-locale-cookie.test.ts`

（shared 没有自己的测试目录，惯例是从消费方模块测——`web/tests/unit/sidebar-state.test.ts` 测的就是 `shared/frontend/sidebar-state.ts`，照此办理。）

**Interfaces:**
- Consumes: `metadata/locale.ts` 的 `t(s: LocalizedString, locale: Locale): string`、`Locale`；`metadata/dataTypes.ts` 的 `LocalizedString`
- Produces:
  - `useT(): (s: LocalizedString) => string` —— 组件里用
  - `localeFromCookie(cookie: string): Locale | null` —— 从 cookie 串解析语言，解析不出返回 null
  - `C` —— 共享词表对象，每个值都是 `LocalizedString`

- [ ] **Step 1: 写失败的测试（共享词表）**

创建 `web/tests/unit/i18n-common.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认它失败**

在 `web/` 下 Run: `npx vitest run tests/unit/i18n-common.test.ts`
Expected: FAIL，无法解析 `shared/frontend/i18n-common`

- [ ] **Step 3: 写共享词表**

创建 `shared/frontend/i18n-common.ts`：

```ts
import type { LocalizedString } from "../../metadata/dataTypes";

// 全站高频词的统一译法。准入线：一个词在 3 个以上模块出现才收进来——
// 页面专属文案一律内联在使用处，否则这里会膨胀成第二个字典，
// 而「文案与使用处分离」正是这次要消灭的东西。
export const C = {
  save: { en: "Save", zh: "保存" },
  cancel: { en: "Cancel", zh: "取消" },
  delete: { en: "Delete", zh: "删除" },
  edit: { en: "Edit", zh: "编辑" },
  add: { en: "Add", zh: "添加" },
  create: { en: "Create", zh: "新建" },
  confirm: { en: "Confirm", zh: "确认" },
  close: { en: "Close", zh: "关闭" },
  back: { en: "Back", zh: "返回" },
  next: { en: "Next", zh: "下一步" },
  search: { en: "Search", zh: "搜索" },
  loading: { en: "Loading…", zh: "加载中…" },
  retry: { en: "Retry", zh: "重试" },
  refresh: { en: "Refresh", zh: "刷新" },
  copy: { en: "Copy", zh: "复制" },
  export: { en: "Export", zh: "导出" },
  name: { en: "Name", zh: "名称" },
  status: { en: "Status", zh: "状态" },
  actions: { en: "Actions", zh: "操作" },
  type: { en: "Type", zh: "类型" },
  date: { en: "Date", zh: "日期" },
  description: { en: "Description", zh: "说明" },
  enabled: { en: "Enabled", zh: "已启用" },
  disabled: { en: "Disabled", zh: "已停用" },
  yes: { en: "Yes", zh: "是" },
  no: { en: "No", zh: "否" },
  none: { en: "None", zh: "无" },
  all: { en: "All", zh: "全部" },
  error: { en: "Error", zh: "错误" },
  settings: { en: "Settings", zh: "设置" },
} satisfies Record<string, LocalizedString>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/i18n-common.test.ts`
Expected: PASS，3 个用例全绿

- [ ] **Step 5: 写失败的测试（useLocale 同步取 cookie）**

创建 `web/tests/unit/use-locale-cookie.test.ts`：

```ts
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
```

- [ ] **Step 6: 跑测试确认它失败**

Run: `npx vitest run tests/unit/use-locale-cookie.test.ts`
Expected: FAIL，`localeFromCookie` 未从 `useLocale` 导出

- [ ] **Step 7: 改 useLocale**

修改 `shared/frontend/hooks/useLocale.ts`。在 `fetchMe` 之后、`useLocale` 之前插入：

```ts
// lang cookie 由 web worker 在登录与切换语言时写入（domain=uni-scrm.com），全模块同步可读。
// 拿它做初值可以免掉「先渲染英文再跳中文」的闪烁；fetch 回来后再纠偏。
export function localeFromCookie(cookie: string): Locale | null {
  const m = cookie.match(/(?:^|;\s*)lang=([^;]*)/);
  if (!m) return null;
  return m[1] === "zh" || m[1] === "en" ? m[1] : null;
}
```

并把 `useLocale` 的函数体替换为：

```ts
export function useLocale(): LocaleState {
  const [state, setState] = useState<LocaleState>(() => ({
    locale: (typeof document !== "undefined" && localeFromCookie(document.cookie)) || "en",
    timezone: "UTC",
    // cookie 只带语言，时区仍要等 fetch，所以这里依旧是 loading。
    loading: true,
  }));

  useEffect(() => {
    let mounted = true;
    fetchMe().then(({ locale, timezone }) => {
      if (mounted) setState({ locale, timezone, loading: false });
    });
    return () => { mounted = false; };
  }, []);

  return state;
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/unit/use-locale-cookie.test.ts tests/unit/i18n-common.test.ts`
Expected: PASS，9 个用例全绿

- [ ] **Step 9: 写 useT hook**

创建 `shared/frontend/hooks/useT.ts`：

```ts
import { useCallback } from "react";
import { t } from "../../../metadata/locale";
import type { LocalizedString } from "../../../metadata/dataTypes";
import { useLocale } from "./useLocale";

// 把 locale 绑进翻译函数，调用处就只剩文案本身：
//   const T = useT();
//   <Button>{T({ en: "Publish", zh: "发布" })}</Button>
//
// 组件之外（列定义工厂之类）继续直接用 metadata/locale 的 t(s, locale) 显式传 locale——
// shared/frontend/lib/metadata-columns.tsx 已经是这个写法。
export function useT(): (s: LocalizedString) => string {
  const { locale } = useLocale();
  return useCallback((s: LocalizedString) => t(s, locale), [locale]);
}
```

- [ ] **Step 10: 类型检查**

在 `web/` 下 Run: `npx tsc --noEmit 2>&1 | grep -E "useT|useLocale|i18n-common"`
Expected: 无输出（本模块另有与本次无关的既有 tsc 报错，只看这三个文件）

- [ ] **Step 11: 提交**

```bash
git add shared/frontend/hooks/useT.ts shared/frontend/i18n-common.ts shared/frontend/hooks/useLocale.ts web/tests/unit/i18n-common.test.ts web/tests/unit/use-locale-cookie.test.ts && git commit -m "feat(shared): inline bilingual string mechanism — useT, common vocabulary, cookie-synced locale"
```

---

### Task 2: i18n 审计脚本

1,500 条改动靠人眼盯不住。这个脚本是「翻完了没有」的客观判据，也是后续每个翻译任务的验收工具，所以必须排在翻译任务之前完成。

**Files:**
- Create: `scripts/i18n-audit.mjs`
- Test: `scripts/i18n-audit.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: 导出纯函数 `findHardcoded(source, relFile)`、`isExempted(source, line)`、`runAudit(root)`；CLI `node scripts/i18n-audit.mjs [--check]`

**照抄既有约定**：`scripts/time-format-audit.mjs` 是同类脚本的样板——导出可单测的纯函数、`main()` 由 `import.meta.url === file://${process.argv[1]}` 守卫、`--check` 时有未豁免项则 exit 1、配套一个 `.test.mjs`。请先读它再动手，保持同一形状。

- [ ] **Step 1: 写失败的测试**

创建 `scripts/i18n-audit.test.mjs`：

```js
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
```

- [ ] **Step 2: 跑测试确认它失败**

在仓库根 Run: `npx vitest run scripts/i18n-audit.test.mjs`
Expected: FAIL，无法解析 `./i18n-audit.mjs`

- [ ] **Step 3: 写脚本**

创建 `scripts/i18n-audit.mjs`：

```js
// UI 文案双语审计：前端所有用户可见文案必须写成 { en, zh } 内联对象，
// 经 useT()/t() 渲染，中文用户看到的才是中文。
//
// 扫描 7 个租户可见的前端目录（admin 是内部工具、本来就是中文，不扫）。
//
// 做法：把每行里的字符串字面量与 JSX 文本节点都取出来，凡是「看起来像英文文案」的就报——
// 首字母大写且含 2 个以上单词，或单个大写开头的词（Dashboard 这类标题）。
// 技术串（URL、路径、全小写标识、常量名、含 <>{}$ 的模板）按黑名单排除；
// 同行出现 `en:` 的视为已翻译，跳过。
//
// 已知局限（不要误以为它等于「翻完了」）：
//   - 跨行的 JSX 文本（<p>\n  Some text\n</p>）抓不到——按行扫描的固有限制
//   - 单个小写单词、纯符号文案抓不到
//   - 因此审计归零只是必要条件，最终判据是 Task 14 的逐页中文目检
//
// 合理的例外用同行或上一行的 `// i18n-ok: <理由>` 豁免（理由必填）。
//
// CLI: node scripts/i18n-audit.mjs [--check]
//   --check 时若有未豁免项则 exit 1。

import fs from "node:fs";
import path from "node:path";

const DIRS = [
  "web/src",
  "link/frontend",
  "flow/frontend",
  "analytics/frontend",
  "insight-segment/frontend",
  "content/frontend",
  "shared/frontend",
];

// 「Save changes」「Last 7 days」这类：首字母大写，后面还有至少一个词。
const SENTENCE = /^[A-Z][A-Za-z0-9]*(?:[ ,.'’\-—:!?()/&%]+[A-Za-z0-9()][A-Za-z0-9()]*)+[.!?…]?$/;
// 「Dashboard」「Channels」这类单词标题——菜单项和列名大量是这种。
const TITLE_WORD = /^[A-Z][a-z]{2,}$/;

function isTechnical(s) {
  const v = s.trim();
  if (/^https?:\/\//.test(v)) return true;      // URL
  if (/^[/.]/.test(v)) return true;             // 路径
  if (/^[a-z][a-zA-Z0-9]*$/.test(v)) return true; // 全小写标识符
  if (/^[A-Z_]+$/.test(v)) return true;         // 常量名
  if (/^\d/.test(v)) return true;               // 数字开头
  if (/[<>{}$]/.test(v)) return true;           // 模板/标记
  if (/^(GET|POST|PUT|DELETE|PATCH|SELECT|INSERT|UPDATE)\b/.test(v)) return true;
  return false;
}

function looksLikeCopy(s) {
  const v = s.trim();
  if (v.length < 3 || v.length > 200) return false;
  if (isTechnical(v)) return false;
  return SENTENCE.test(v) || TITLE_WORD.test(v);
}

// 一行里出现 en: "..."，说明这行的字符串已经在双语对象里了。
function alreadyBilingual(line) {
  return /\ben\s*:\s*["'`]/.test(line);
}

// 长度限定必须是 * 而不是 {3,200}：同一行里若先出现一个短串（如 value: "a"），
// {3,} 会配不上那对引号，正则就从错误的位置继续，把后面真正的文案整个跳过。
const STR = /"([^"\\\n]*)"|'([^'\\\n]*)'/g;
const JSX_TEXT = />\s*([A-Z][^<>{}\n]{2,}?)\s*</g;

// 这些属性里的字符串是技术值，不是给人看的文案。
const TECH_ATTR = /className|classname|data-|aria-hidden|key=|id=|href=|src=|type=|role=|import\(/;

export function findHardcoded(source, relFile) {
  if (!/\.(tsx|ts)$/.test(relFile)) return [];
  const out = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (alreadyBilingual(line)) continue;
    if (/^\s*(?:import|export\s+\*|export\s+\{)/.test(line)) continue;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;

    const seen = new Set();
    let m;
    STR.lastIndex = 0;
    while ((m = STR.exec(line)) !== null) {
      const text = m[1] ?? m[2];
      if (TECH_ATTR.test(line.slice(Math.max(0, m.index - 30), m.index))) continue;
      if (looksLikeCopy(text) && !seen.has(text)) {
        seen.add(text);
        out.push({ line: i + 1, text: text.slice(0, 80) });
      }
    }
    JSX_TEXT.lastIndex = 0;
    while ((m = JSX_TEXT.exec(line)) !== null) {
      const text = m[1];
      if (looksLikeCopy(text) && !seen.has(text)) {
        seen.add(text);
        out.push({ line: i + 1, text: text.slice(0, 80) });
      }
    }
  }
  return out;
}

export function isExempted(source, line) {
  const lines = source.split("\n");
  const re = /\/\/\s*i18n-ok:\s*\S|\{\/\*\s*i18n-ok:\s*\S/;
  return re.test(lines[line - 1] || "") || re.test(lines[line - 2] || "");
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
}

export function runAudit(root) {
  const files = [];
  for (const d of DIRS) walk(path.join(root, d), files);
  const findings = [], exempted = [], unexempted = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file);
    for (const v of findHardcoded(source, rel)) {
      const rec = { file: rel, ...v };
      findings.push(rec);
      (isExempted(source, v.line) ? exempted : unexempted).push(rec);
    }
  }
  return { findings, exempted, unexempted };
}

function main() {
  const check = process.argv.includes("--check");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { findings, exempted, unexempted } = runAudit(root);
  const byFile = new Map();
  for (const f of unexempted) byFile.set(f.file, (byFile.get(f.file) || 0) + 1);
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${file}`);
  }
  console.log(`\n${findings.length} findings, ${exempted.length} exempted, ${unexempted.length} unexempted`);
  if (check && unexempted.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/i18n-audit.test.mjs`
Expected: PASS，16 个用例全绿

- [ ] **Step 5: 跑一次全量，核对基线**

Run: `node scripts/i18n-audit.mjs`

本计划写成时的实测基线（供对照，若你的数字明显偏离说明脚本抄错了）：

| 目录 | 未豁免数 |
|---|---|
| flow/frontend | 211 |
| web/src | 128 |
| analytics/frontend | 119 |
| shared/frontend | 97 |
| link/frontend | 79 |
| insight-segment/frontend | 18 |
| content/frontend | 18 |
| **合计** | **670** |

最重的单个文件：`flow/frontend/components/Inspector.tsx` 105 条、`analytics/frontend/components/ReportConfig.tsx` 39 条、`analytics/frontend/pages/AnalyticsDetail.tsx` 38 条、`shared/frontend/Sidebar.tsx` 32 条。

（`web/src/lib/i18n.ts` 的 28 条会随 Task 3 删除该文件而自然归零。）

**把你实测到的总数记进报告**——它是后续每个翻译任务的进度基准。

- [ ] **Step 6: 提交**

```bash
git add scripts/i18n-audit.mjs scripts/i18n-audit.test.mjs && git commit -m "feat(scripts): i18n audit — flag hardcoded English UI copy"
```

---

### Task 3: web 模块退役 i18next

**Files:**
- Delete: `web/src/lib/i18n.ts`
- Modify: `web/src/pages/Settings.tsx`、`web/src/components/PasswordCard.tsx`、`web/src/hooks/useAuth.tsx`、`web/src/App.tsx`、`web/package.json`

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: web 模块不再依赖 i18next；仓库内不得再有 `i18next` / `react-i18next` 引用

现有 `web/src/lib/i18n.ts` 里的 30 个 key 已经有完整中文译文，**直接复用这些译文，不要重译**——它们是既有产品用词。

- [ ] **Step 1: 把译文搬到使用处**

`Settings.tsx` 与 `PasswordCard.tsx` 目前经 `useTranslation()` 的 `t("settings.title")` 取文案。逐个改成内联式：`const T = useT();`，`t("settings.title")` → `T({ en: "Settings", zh: "设置" })`。译文照抄 `i18n.ts` 里对应 key 的 zh 值。

对照表（从 `i18n.ts` 抄，逐字保留）：

| 原 key | en | zh |
|---|---|---|
| settings.title | Settings | 设置 |
| settings.region | Region | 地区 |
| settings.language | Language | 语言 |
| settings.timezone | Timezone | 时区 |
| settings.connectedAccounts | Connected Accounts | 已连接账号 |
| settings.disconnect | Disconnect | 断开 |
| settings.connect | Connect | 连接 |
| region.global | Global | 全球 |
| region.china | China | 中国 |
| password.title | Password | 密码 |
| password.loading | Loading… | 加载中… |
| password.loadError | Couldn't load password status. Please try again. | 密码状态加载失败，请重试。 |
| password.retry | Retry | 重试 |
| password.notSet | Not set — you sign in with an email link or a connected account | 未设置——你目前通过邮件登录链接或已连接的账号登录 |
| password.isSet | Password is set | 已设置密码 |
| password.set | Set password | 设置密码 |
| password.change | Change password | 修改密码 |
| password.current | Current password | 当前密码 |
| password.new | New password | 新密码 |
| password.confirm | Confirm new password | 确认新密码 |
| password.save | Save | 保存 |
| password.cancel | Cancel | 取消 |
| password.mismatch | The two passwords do not match | 两次输入的密码不一致 |
| password.saved | Password updated. Other devices have been signed out. | 密码已更新，其它设备上的登录已被退出。 |

`password.save` / `password.cancel` / `password.retry` / `password.loading` 改用共享词表：`T(C.save)`、`T(C.cancel)`、`T(C.retry)`、`T(C.loading)`。

`nav.*` 那 5 个 key 若已无人引用（grep 确认），随文件一并删除。

- [ ] **Step 2: 切语言后刷新页面**

`Settings.tsx` 里语言下拉的 onChange 原本调 `i18n.changeLanguage(...)` 做实时切换。改为在 `updateLanguage(...)` 成功后 `window.location.reload()`：

```tsx
onChange={async (e: React.ChangeEvent<HTMLSelectElement>) => {
  await updateLanguage(e.target.value);
  // 内联双语串由 useLocale 的 cookie 初值驱动，而 lang cookie 是后端在这次请求里写的。
  // 重新加载一次让整页拿到新语言——用一次刷新换掉整个 i18next 依赖，划算。
  window.location.reload();
}}
```

`useAuth.tsx` 里删掉 `i18n.changeLanguage(...)` 调用与 `useTranslation` import；`App.tsx` 删掉 `import "./lib/i18n";`。

- [ ] **Step 3: 删文件与依赖**

```bash
rm web/src/lib/i18n.ts
```

在 `web/` 下 Run: `npm uninstall i18next react-i18next`

- [ ] **Step 4: 确认无残留**

在仓库根 Run: `grep -rn "i18next\|useTranslation" --include="*.ts" --include="*.tsx" --include="*.json" . | grep -v node_modules | grep -v "/dist/"`
Expected: 无输出（package-lock.json 也应随 npm uninstall 更新干净）

- [ ] **Step 5: 测试与构建**

在 `web/` 下 Run: `npx vitest run`
Expected: 失败数不超过改动前基线（改动前先跑一次记下数字）

Run: `npx vite build --mode development`
Expected: 构建成功

- [ ] **Step 6: 提交**

```bash
git add web/src web/package.json web/package-lock.json && git commit -m "refactor(web): retire i18next in favour of inline bilingual strings"
```

---

### Task 4: 翻译 web/src 其余页面

**Files:**
- Modify: `web/src/pages/Billing.tsx`、`Login.tsx`、`CreditUsage.tsx`、`Home.tsx`、`CompleteProfile.tsx`、`Verify.tsx`，以及 `web/src/components/` 下其余含文案的文件

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: 无（纯文案改动）

**做法**（后续所有翻译任务同此，不再重复）：

1. 在组件顶部 `const T = useT();`（import 自 `../../../shared/frontend/hooks/useT`，相对路径按文件位置调整）
2. 每条用户可见英文改成 `{T({ en: "原文", zh: "译文" })}`，原文**逐字保留不得改动**
3. 属性值同理：`placeholder={T({ en: "your@email.com", zh: "your@email.com" })}` —— 邮箱示例这类内容 en/zh 相同也要写全两个字段（`LocalizedString` 要求 zh 必填）
4. 高频词用 `T(C.save)` 形式
5. 非组件上下文（模块级常量、工厂函数）不能用 hook，改在组件内取 `const { locale } = useLocale()` 后用 `t(obj, locale)`
6. **Login.tsx 特别注意**：这是登出状态下的页面，`useLocale` 的 `/api/auth/me` 会 401，此时 locale 回落到 cookie 值（用户上次登录时写的）或 en——这是正确行为，不要为此加特殊处理

- [ ] **Step 1: 记下本模块基线**

Run: `node scripts/i18n-audit.mjs | grep "web/src"`
Expected: 列出 web/src 各文件的未翻译计数，记进报告

- [ ] **Step 2: 逐文件翻译**

按上述做法处理 Step 1 列出的每个文件。术语与风格严格遵守 Global Constraints 的术语表。

- [ ] **Step 3: 审计确认清零**

Run: `node scripts/i18n-audit.mjs | grep "web/src"`
Expected: 无输出（web/src 已无未豁免项）。若个别条目确实不该翻（纯技术串），加 `// i18n-ok: <理由>` 并在报告里逐条说明理由。

- [ ] **Step 4: 类型检查与构建**

在 `web/` 下 Run: `npx tsc --noEmit 2>&1 | grep "src/"`
Expected: 无新增报错（先记下改动前的既有报错做对比）

Run: `npx vite build --mode development`
Expected: 构建成功

- [ ] **Step 5: 测试**

Run: `npx vitest run`
Expected: 失败数不超过基线

- [ ] **Step 6: 提交**

```bash
git add web/src && git commit -m "i18n(web): translate remaining pages to bilingual strings"
```

---

### Task 5: 翻译 shared/frontend

shared 的文案会出现在每个模块里，先做它收益最大。**Sidebar 的 20 个菜单项是全站最显眼的英文**。

**Files:**
- Modify: `shared/frontend/Sidebar.tsx`、`Nav.tsx`、`UpgradeIcon.tsx`、`components/ConfirmDialog.tsx`、`ui/dialog.tsx`、`ui/sheet.tsx`，以及 `shared/frontend/` 下其余含文案的文件

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: 无

- [ ] **Step 1: 记下基线**

Run: `node scripts/i18n-audit.mjs | grep "shared/frontend"`

- [ ] **Step 2: Sidebar 菜单项**

`Sidebar.tsx` 的 `groups` 数组里每个 `label:` 都是英文字面量。把 `MenuItem`/`MenuGroup` 接口的 `label: string` 改成 `label: LocalizedString`，数组里逐个改写为双语对象，渲染处 `{T(group.label)}`。译法（对齐术语表）：

| en | zh | | en | zh |
|---|---|---|---|---|
| Social | 社交 | | Commerce | 商品 |
| Channels | 渠道 | | Insight | 洞察 |
| User Flow | 用户流程 | | Dashboard | 仪表盘 |
| Users | 用户 | | Analytics | 分析 |
| Lists | 名单 | | Settings | 设置 |
| Profile | 画像 | | General | 通用 |
| Segments | 分群 | | Billing | 账单 |
| Content | 内容 | | Credit Usage | 额度用量 |
| Content Flow | 内容流程 | | Logout | 退出 |
| Recommendation | 推荐 | | Collapse（tooltip） | 收起 |
| Content Library | 内容库 | | Expand（tooltip） | 展开 |
| AI Content Settings | AI 内容设置 | | | |

- [ ] **Step 3: prop 驱动组件的默认值**

`ConfirmDialog.tsx` 的 `confirmLabel = "Confirm"` / `cancelLabel = "Cancel"` 改为可选 `LocalizedString`，缺省取 `C.confirm` / `C.cancel`，渲染时 `T(...)`。`EmptyState.tsx` 的 `title`/`description` 全部由调用方传入，**组件本身不改**——那些文案在各模块的调用处翻译。

`ui/dialog.tsx`、`ui/sheet.tsx` 里给读屏用的 `sr-only` "Close" 一并翻译。

- [ ] **Step 4: 其余文件**

按 Task 4 Step 2 的做法处理 Step 1 列出的其余文件。

- [ ] **Step 5: 审计确认清零**

Run: `node scripts/i18n-audit.mjs | grep "shared/frontend"`
Expected: 无输出

- [ ] **Step 6: 全模块构建验证**

shared 被 6 个模块引用，改了它的接口（`label: LocalizedString`）必须确认每个模块都还能编译。**逐个**在模块目录下跑：

```bash
for m in web link flow analytics insight-segment content; do (cd $m && echo "--- $m ---" && npx vite build --mode development >/dev/null 2>&1 && echo OK || echo BUILD FAILED); done
```

Expected: 6 个全部 OK。任何一个 FAILED 都要修好再继续——多半是某个模块给 Sidebar 传了字符串 label。

- [ ] **Step 7: 提交**

```bash
git add shared/frontend && git commit -m "i18n(shared): translate sidebar, dialogs and shared components"
```

---

### Task 6: 翻译 link/frontend

**Files:**
- Modify: `link/frontend/` 下全部含文案的文件。最重的是 `components/SocialChannels.tsx`（549 行），其次 `ShopifyConnect.tsx`、`NotionConnect.tsx`、`ProductTable.tsx`、`ContentTable.tsx`、`LocalImport.tsx`、`pages/Lists.tsx`

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: 无

本模块多个文件**已经在用 `useLocale()`** 渲染元数据标签（ChannelCard、ContentTable、ProductTable、SocialChannels、FrozenNotice、Users、LocalImport）——这些文件里 `const { locale } = useLocale()` 已存在，加 `const T = useT();` 即可，两者并存无冲突。

- [ ] **Step 1: 记下基线**

Run: `node scripts/i18n-audit.mjs | grep "link/frontend"`

- [ ] **Step 2: 逐文件翻译**

按 Task 4 Step 2 的做法。渠道名（X / YouTube / TikTok / Shopify / Notion）保留英文；"Connect" → "连接"，"Disconnect" → "断开"，"Sync" → "同步"，"Channels" → "渠道"，"Lists" → "名单"。

- [ ] **Step 3: 审计确认清零**

Run: `node scripts/i18n-audit.mjs | grep "link/frontend"`
Expected: 无输出

- [ ] **Step 4: 类型检查与构建**

在 `link/` 下 Run: `npx tsc --noEmit 2>&1 | grep "frontend/"` —— 无新增报错
Run: `npx vite build --mode development` —— 构建成功

- [ ] **Step 5: 测试**

Run: `npx vitest run`
Expected: 失败数不超过基线

- [ ] **Step 6: 提交**

```bash
git add link/frontend && git commit -m "i18n(link): translate channels, content and lists UI"
```

---

### Task 7: flow 节点标签映射表

`flow/nodeTypeRegistry.ts` 在禁改名单里，但它的 17 个节点 `label` 与 `description` 是硬编码英文，且会显示在画布、调色板和 Inspector 标题上。做一张外部映射表。

**Files:**
- Create: `flow/frontend/config/nodeTypeLabels.ts`
- Test: `flow/tests/unit/node-type-labels.test.ts`
- Modify: `flow/frontend/components/Sidebar.tsx`（调色板）

**Interfaces:**
- Consumes: Task 1 的 `useT`；`flow/nodeTypeRegistry.ts` 的 `NODE_TYPE_REGISTRY`（只读，不改）
- Produces: `NODE_TYPE_LABELS: Record<string, { label: LocalizedString; description: LocalizedString }>`、`nodeLabel(nodeType: string): LocalizedString`、`nodeDescription(nodeType: string): LocalizedString | null`

**注册表实际内容**（已核实，17 个节点；**其中 5 个没有 description**，映射表里 description 必须是可选字段）：

| key | label | description |
|---|---|---|
| cronTrigger | Cron Trigger | Trigger on a schedule |
| waitForEvent | Wait for Event | Check if event has occurred |
| userPropsCondition | User Props | Branch by user properties |
| xAction | X Action | *(无)* |
| addToList | Add to List | Add user to a profile list |
| xContentTrigger | X Trigger | *(无)* |
| youtubeContentTrigger | YouTube Trigger | Watches a subscribed YouTube channel |
| xContentAction | X Action | *(无)* |
| tiktokContentAction | TikTok Action | *(无)* |
| youtubeContentAction | YouTube Action | *(无)* |
| videoAction | Video Action | Add translated subtitles to the content |
| videoCondition | Video Condition | Sample frames across the video and branch on the face ratio |
| youtubeCondition | YouTube Condition | Re-check the trigger video |
| wait | Wait | Delay for a specified duration |
| timeCondition | Time Condition | Gate by time-of-day / day-of-week |
| abSplit | A/B Split | Split traffic by % or condition |
| webhook | Webhook | Send HTTP request |

- [ ] **Step 1: 核对注册表未变**

Run: `grep -c "label:" flow/nodeTypeRegistry.ts`
若节点数与上表 17 个不符，说明注册表在本计划写成后有变动——以文件实际内容为准，并在报告里说明差异。

- [ ] **Step 2: 写失败的测试**

创建 `flow/tests/unit/node-type-labels.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { NODE_TYPE_LABELS, nodeLabel, nodeDescription } from "../../frontend/config/nodeTypeLabels";

describe("NODE_TYPE_LABELS", () => {
  // 注册表是禁改文件，映射表在外面——两者必须一一对应。
  // 将来注册表加了节点而这里漏加，画布上就会冒出一个英文标签，这个测试就是那道闸。
  it("覆盖注册表里的每一个节点类型", () => {
    for (const nodeType of Object.keys(NODE_TYPE_REGISTRY)) {
      expect(NODE_TYPE_LABELS, `缺少节点 ${nodeType} 的译文`).toHaveProperty(nodeType);
    }
  });

  it("没有多余的、注册表里不存在的节点类型", () => {
    for (const nodeType of Object.keys(NODE_TYPE_LABELS)) {
      expect(NODE_TYPE_REGISTRY, `${nodeType} 不在注册表里`).toHaveProperty(nodeType);
    }
  });

  it("每条 label 的 en 与 zh 都非空", () => {
    for (const [nodeType, v] of Object.entries(NODE_TYPE_LABELS)) {
      expect(v.label.en, `${nodeType}.label.en`).toBeTruthy();
      expect(v.label.zh, `${nodeType}.label.zh`).toBeTruthy();
    }
  });

  // 17 个节点里有 5 个（xAction、xContentTrigger、xContentAction、tiktokContentAction、
  // youtubeContentAction）在注册表里就没有 description，映射表也不该凭空造一个。
  // 但凡写了 description，两种语言就都得有。
  it("写了 description 的条目，en 与 zh 都非空", () => {
    for (const [nodeType, v] of Object.entries(NODE_TYPE_LABELS)) {
      if (!v.description) continue;
      expect(v.description.en, `${nodeType}.description.en`).toBeTruthy();
      expect(v.description.zh, `${nodeType}.description.zh`).toBeTruthy();
    }
  });

  it("注册表里有 description 的节点，映射表也必须有", () => {
    for (const [nodeType, def] of Object.entries(NODE_TYPE_REGISTRY)) {
      if ((def as any).description) {
        expect(NODE_TYPE_LABELS[nodeType].description, `${nodeType} 漏了 description 译文`).toBeTruthy();
      }
    }
  });

  // en 必须与注册表逐字一致，否则等于在映射表里偷偷改了英文文案
  it("en 文案与注册表逐字一致", () => {
    for (const [nodeType, def] of Object.entries(NODE_TYPE_REGISTRY)) {
      if ((def as any).label) {
        expect(NODE_TYPE_LABELS[nodeType].label.en).toBe((def as any).label);
      }
    }
  });

  it("nodeLabel 对未知节点回落到节点 id 而不是抛错", () => {
    expect(nodeLabel("nonexistentNode")).toEqual({ en: "nonexistentNode", zh: "nonexistentNode" });
  });

  it("nodeDescription 对未知节点返回 null", () => {
    expect(nodeDescription("nonexistentNode")).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认它失败**

在 `flow/` 下 Run: `npx vitest run tests/unit/node-type-labels.test.ts`
Expected: FAIL，无法解析 `nodeTypeLabels`

- [ ] **Step 4: 写映射表**

创建 `flow/frontend/config/nodeTypeLabels.ts`，**照抄如下全文**（en 逐字取自注册表，zh 按术语表译）：

```ts
import type { LocalizedString } from "../../../metadata/dataTypes";

// flow/nodeTypeRegistry.ts 在禁改名单里，而它的 label/description 是硬编码英文且会显示在
// 画布、调色板与 Inspector 标题上。译文只能放在外部这张表里，按节点 id 关联。
// 注册表新增节点时这里必须同步——node-type-labels.test.ts 会把漏加拦下来。
//
// description 是可选的：注册表里有 5 个节点本来就没有 description，这里也不凭空造。
export const NODE_TYPE_LABELS: Record<string, { label: LocalizedString; description?: LocalizedString }> = {
  cronTrigger: {
    label: { en: "Cron Trigger", zh: "定时触发器" },
    description: { en: "Trigger on a schedule", zh: "按计划定时触发" },
  },
  waitForEvent: {
    label: { en: "Wait for Event", zh: "等待事件" },
    description: { en: "Check if event has occurred", zh: "检查事件是否已发生" },
  },
  userPropsCondition: {
    label: { en: "User Props", zh: "用户属性" },
    description: { en: "Branch by user properties", zh: "按用户属性分支" },
  },
  xAction: {
    label: { en: "X Action", zh: "X 动作" },
  },
  addToList: {
    label: { en: "Add to List", zh: "加入名单" },
    description: { en: "Add user to a profile list", zh: "把用户加入画像名单" },
  },
  xContentTrigger: {
    label: { en: "X Trigger", zh: "X 触发器" },
  },
  youtubeContentTrigger: {
    label: { en: "YouTube Trigger", zh: "YouTube 触发器" },
    description: { en: "Watches a subscribed YouTube channel", zh: "监听已订阅的 YouTube 频道" },
  },
  xContentAction: {
    label: { en: "X Action", zh: "X 动作" },
  },
  tiktokContentAction: {
    label: { en: "TikTok Action", zh: "TikTok 动作" },
  },
  youtubeContentAction: {
    label: { en: "YouTube Action", zh: "YouTube 动作" },
  },
  videoAction: {
    label: { en: "Video Action", zh: "视频动作" },
    description: { en: "Add translated subtitles to the content", zh: "给内容添加翻译字幕" },
  },
  videoCondition: {
    label: { en: "Video Condition", zh: "视频条件" },
    description: {
      en: "Sample frames across the video and branch on the face ratio",
      zh: "在视频中抽帧，按人脸占比分支",
    },
  },
  youtubeCondition: {
    label: { en: "YouTube Condition", zh: "YouTube 条件" },
    description: { en: "Re-check the trigger video", zh: "重新检查触发的视频" },
  },
  wait: {
    label: { en: "Wait", zh: "等待" },
    description: { en: "Delay for a specified duration", zh: "延迟指定时长" },
  },
  timeCondition: {
    label: { en: "Time Condition", zh: "时间条件" },
    description: { en: "Gate by time-of-day / day-of-week", zh: "按时段 / 星期几放行" },
  },
  abSplit: {
    label: { en: "A/B Split", zh: "A/B 分流" },
    description: { en: "Split traffic by % or condition", zh: "按百分比或条件分流" },
  },
  webhook: {
    label: { en: "Webhook", zh: "Webhook" },
    description: { en: "Send HTTP request", zh: "发送 HTTP 请求" },
  },
};

export function nodeLabel(nodeType: string): LocalizedString {
  return NODE_TYPE_LABELS[nodeType]?.label ?? { en: nodeType, zh: nodeType };
}

export function nodeDescription(nodeType: string): LocalizedString | null {
  return NODE_TYPE_LABELS[nodeType]?.description ?? null;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/unit/node-type-labels.test.ts`
Expected: PASS，8 个用例全绿

- [ ] **Step 6: 调色板接上映射表**

`flow/frontend/components/Sidebar.tsx` 渲染节点调色板时用的是注册表的 label/description。改成 `const T = useT();` 后 `{T(nodeLabel(nodeType))}` / `{T(nodeDescription(nodeType) ?? { en: "", zh: "" })}`。该文件自身其余英文文案一并翻译。

- [ ] **Step 7: 构建与提交**

在 `flow/` 下 Run: `npx vite build --mode development` —— 构建成功

```bash
git add flow/frontend/config/nodeTypeLabels.ts flow/tests/unit/node-type-labels.test.ts flow/frontend/components/Sidebar.tsx && git commit -m "i18n(flow): node type label map outside the protected registry"
```

---

### Task 8: 翻译 flow/frontend/components/Inspector.tsx

单文件 1,535 行，是全仓库最大的文案聚集地，独立成一个任务。

**Files:**
- Modify: `flow/frontend/components/Inspector.tsx`

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`；Task 7 的 `nodeLabel`
- Produces: 无

**这个文件里有一处必须顺手修的真问题**：它在 7 个地方调用 `localizeLabel(someMetadataLabel, "en")` ——locale 被写死成 `"en"`。这些元数据标签本身早就有中文译文，只是被强制显示英文。行号 476、741、791、818、914、935、1197（以实际 grep 结果为准）。改成用当前 locale：

```tsx
const { locale } = useLocale();
// …
localizeLabel(op.label, locale)
```

- [ ] **Step 1: 记下基线并定位硬编码 locale**

在仓库根 Run: `node scripts/i18n-audit.mjs | grep "Inspector"`
Run: `grep -n ', *"en")' flow/frontend/components/Inspector.tsx`
Expected: 后者列出 7 处，全部要改

- [ ] **Step 2: 修掉硬编码的 "en"**

在组件内取 `const { locale } = useLocale();`，把 7 处 `localizeLabel(x, "en")` 改成 `localizeLabel(x, locale)`。若某处在组件外的辅助函数里，给该函数加一个 `locale: Locale` 参数，由调用处传入——不要在函数内部调 hook。

- [ ] **Step 3: 翻译本文件全部文案**

按 Task 4 Step 2 的做法。字段标签、占位符、tooltip、按钮、空状态逐条处理。术语严格对齐术语表——本文件里 Trigger/Action/Condition/Node 出现频率极高，译法漂移会非常明显。

- [ ] **Step 4: 审计确认清零**

Run: `node scripts/i18n-audit.mjs | grep "Inspector"`
Expected: 无输出

Run: `grep -n ', *"en")' flow/frontend/components/Inspector.tsx`
Expected: 无输出

- [ ] **Step 5: 类型检查、构建、测试**

在 `flow/` 下 Run: `npx tsc --noEmit 2>&1 | grep "Inspector"` —— 无新增报错
Run: `npx vite build --mode development` —— 构建成功
Run: `npx vitest run` —— 失败数不超过基线

- [ ] **Step 6: 提交**

```bash
git add flow/frontend/components/Inspector.tsx && git commit -m "i18n(flow): translate Inspector; stop pinning metadata labels to English"
```

---

### Task 9: 翻译 flow/frontend 其余文件

**Files:**
- Modify: `flow/frontend/` 下除 `components/Inspector.tsx`、`components/Sidebar.tsx`、`config/nodeTypeLabels.ts` 之外全部含文案的文件。主要是 `pages/FlowsPage.tsx`、`pages/EditorPage.tsx`、`pages/AnalyticsPage.tsx`、`nodes/*.tsx`

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`；Task 7 的 `nodeLabel`、`nodeDescription`
- Produces: 无

`nodes/ActionNode.tsx` 有 2 处 `localizeLabel(..., "en")` 硬编码，同 Task 8 一并改成当前 locale。各 `nodes/*.tsx` 里显示节点名的地方改用 `nodeLabel(nodeType)`。

- [ ] **Step 1: 记下基线**

Run: `node scripts/i18n-audit.mjs | grep "flow/frontend"`

- [ ] **Step 2: 逐文件翻译**

按 Task 4 Step 2 的做法。

- [ ] **Step 3: 修掉剩余的硬编码 locale**

Run: `grep -rn ', *"en")' flow/frontend/`
把找到的每一处改成当前 locale（组件内 `useLocale()`，组件外加参数）。

- [ ] **Step 4: 审计与硬编码 locale 双清零**

Run: `node scripts/i18n-audit.mjs | grep "flow/frontend"` —— 无输出
Run: `grep -rn ', *"en")' flow/frontend/` —— 无输出

- [ ] **Step 5: 类型检查、构建、测试**

在 `flow/` 下 Run: `npx tsc --noEmit 2>&1 | grep "frontend/"` —— 无新增报错
Run: `npx vite build --mode development` —— 构建成功
Run: `npx vitest run` —— 失败数不超过基线

- [ ] **Step 6: 提交**

```bash
git add flow/frontend && git commit -m "i18n(flow): translate pages, nodes and remaining components"
```

---

### Task 10: 翻译 analytics 的 AnalyticsDetail 与 ReportConfig

两个文件合计 1,199 行，占本模块文案的大半。

**Files:**
- Modify: `analytics/frontend/pages/AnalyticsDetail.tsx`（854 行）、`analytics/frontend/components/ReportConfig.tsx`（345 行）

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: 无

两个文件都**已经在用 `useLocale()`**，加 `const T = useT();` 即可并存。

- [ ] **Step 1: 记下基线**

Run: `node scripts/i18n-audit.mjs | grep -E "AnalyticsDetail|ReportConfig"`

- [ ] **Step 2: 逐文件翻译**

按 Task 4 Step 2 的做法。图表相关术语建议：Metric→指标、Dimension→维度、Filter→筛选、Group by→分组、Funnel→漏斗、Retention→留存、Chart→图表、Table→表格、Row→行、Column→列、Range→范围。

**注意**：图表坐标轴的时间标签受 `time-format-audit.mjs` 管辖且已有豁免注释，**不要动那些格式化调用**，只翻它们周围的说明文字。

- [ ] **Step 3: 审计确认清零**

Run: `node scripts/i18n-audit.mjs | grep -E "AnalyticsDetail|ReportConfig"` —— 无输出

- [ ] **Step 4: 确认没碰坏时间格式**

在仓库根 Run: `node scripts/time-format-audit.mjs --check`
Expected: 退出码 0，未豁免项为 0

- [ ] **Step 5: 类型检查、构建、测试**

在 `analytics/` 下 Run: `npx tsc --noEmit 2>&1 | grep -E "AnalyticsDetail|ReportConfig"` —— 无新增报错
Run: `npx vite build --mode development` —— 构建成功
Run: `npx vitest run` —— 失败数不超过基线

- [ ] **Step 6: 提交**

```bash
git add analytics/frontend/pages/AnalyticsDetail.tsx analytics/frontend/components/ReportConfig.tsx && git commit -m "i18n(analytics): translate report detail and config"
```

---

### Task 11: 翻译 analytics 其余文件

**Files:**
- Modify: `analytics/frontend/` 下除 Task 10 两个文件外全部含文案的文件。主要是 `pages/DashboardPage.tsx`、`pages/AnalyticsList.tsx`、`components/IntervalDistributionChart.tsx`

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: 无

- [ ] **Step 1: 记下基线**

Run: `node scripts/i18n-audit.mjs | grep "analytics/frontend"`

- [ ] **Step 2: 逐文件翻译**

按 Task 4 Step 2 的做法，术语沿用 Task 10 的图表术语。

- [ ] **Step 3: 审计与时间格式双确认**

Run: `node scripts/i18n-audit.mjs | grep "analytics/frontend"` —— 无输出
在仓库根 Run: `node scripts/time-format-audit.mjs --check` —— 退出码 0

- [ ] **Step 4: 类型检查、构建、测试**

在 `analytics/` 下 Run: `npx tsc --noEmit 2>&1 | grep "frontend/"` —— 无新增报错
Run: `npx vite build --mode development` —— 构建成功
Run: `npx vitest run` —— 失败数不超过基线

- [ ] **Step 5: 提交**

```bash
git add analytics/frontend && git commit -m "i18n(analytics): translate dashboard, list and charts"
```

---

### Task 12: 翻译 insight-segment/frontend

小模块（8 文件 / 450 行），且**目前完全没有 locale 机制**——本任务顺带把它接进来。

**Files:**
- Modify: `insight-segment/frontend/pages/Segments.tsx`、`SegmentCreate.tsx`、`SegmentDetail.tsx` 及其余含文案的文件

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: 无

`SegmentDetail.tsx` 里有原生 `confirm("Delete this segment?")`——字符串照常翻译成 `confirm(T({ en: "Delete this segment?", zh: "删除这个分群？" }))`，**不要顺手换成自定义对话框组件**，那是另一件事。

- [ ] **Step 1: 记下基线**

Run: `node scripts/i18n-audit.mjs | grep "insight-segment"`

- [ ] **Step 2: 逐文件翻译**

按 Task 4 Step 2 的做法。Segment→分群、Condition→条件、Rule→规则、Membership→成员归属、Preview→预览。

- [ ] **Step 3: 审计确认清零**

Run: `node scripts/i18n-audit.mjs | grep "insight-segment"` —— 无输出

- [ ] **Step 4: 类型检查、构建、测试**

在 `insight-segment/` 下 Run: `npx tsc --noEmit 2>&1 | grep "frontend/"` —— 无新增报错
Run: `npx vite build --mode development` —— 构建成功
Run: `npx vitest run` —— 失败数不超过基线

- [ ] **Step 5: 提交**

```bash
git add insight-segment/frontend && git commit -m "i18n(insight-segment): translate segment pages"
```

---

### Task 13: 翻译 content/frontend

最小模块（7 文件 / 349 行），文案几乎全在 `pages/SettingsPage.tsx`。同样**目前没有 locale 机制**。

**Files:**
- Modify: `content/frontend/pages/SettingsPage.tsx` 及其余含文案的文件

**Interfaces:**
- Consumes: Task 1 的 `useT`、`C`
- Produces: 无

- [ ] **Step 1: 记下基线**

Run: `node scripts/i18n-audit.mjs | grep "content/frontend"`

- [ ] **Step 2: 逐文件翻译**

按 Task 4 Step 2 的做法。本模块是 BYOK 大模型密钥管理 + 内置 skill 配方：API Key→API Key（保留）、Model→模型、Prompt→提示词、Provider→服务商、Recipe/Skill→配方。

- [ ] **Step 3: 审计确认清零**

Run: `node scripts/i18n-audit.mjs | grep "content/frontend"` —— 无输出

- [ ] **Step 4: 类型检查、构建、测试**

在 `content/` 下 Run: `npx tsc --noEmit 2>&1 | grep "frontend/"` —— 无新增报错
Run: `npx vite build --mode development` —— 构建成功
Run: `npx vitest run` —— 失败数不超过基线

- [ ] **Step 5: 提交**

```bash
git add content/frontend && git commit -m "i18n(content): translate AI content settings"
```

---

### Task 14: 全量部署与中文走查

localhost 通过不算完成——必须部署到 dev 并在浏览器里用中文实际走一遍。

**Files:** 无（部署与验证）

**Interfaces:**
- Consumes: 前 13 个任务的全部产出

- [ ] **Step 1: 审计全绿**

在仓库根 Run: `node scripts/i18n-audit.mjs --check`
Expected: 退出码 0，`unexempted` 为 0。若仍有残留，回到对应模块的任务补完。

- [ ] **Step 2: 全仓库测试**

逐模块在其目录下 Run: `npx vitest run`
Expected: 每个模块的失败数都不超过各自基线。同时在仓库根 Run: `npx vitest run scripts/i18n-audit.test.mjs` —— 全绿。

- [ ] **Step 3: 部署 6 个模块到 dev**

analytics 与 content 用了 Container，本机若无 Docker 会卡住；这两个模块改用 `npx vite build --mode development && wrangler deploy --env dev --containers-rollout=none`（只改了前端资源，容器镜像不动）。其余 4 个用 `npm run deploy:dev`。

```bash
for m in web link flow insight-segment; do (cd $m && echo "--- $m ---" && npm run deploy:dev 2>&1 | tail -3); done
for m in analytics content; do (cd $m && echo "--- $m ---" && npx vite build --mode development >/dev/null && wrangler deploy --env dev --containers-rollout=none 2>&1 | tail -3); done
```

Expected: 6 个模块各自输出自己的 `*-dev.uni-scrm.com (custom domain)`

- [ ] **Step 4: 切成中文**

用真实的已登录 Chrome 会话（先调 `tabs_context_mcp`）。打开 `https://web-dev.uni-scrm.com/settings`，把 Language 切成「简体中文」，确认页面刷新后 Settings 页整体变为中文。

- [ ] **Step 5: 逐页目检**

依次访问并确认**没有残留英文**（产品名、X/YouTube/TikTok、Webhook/API 这类保留词除外）：

1. `web-dev.uni-scrm.com/settings` —— 设置各卡片、密码卡片
2. `web-dev.uni-scrm.com/billing` —— 套餐与账单
3. `web-dev.uni-scrm.com/credit-usage` —— 额度用量表格
4. `link-dev.uni-scrm.com/channel` —— 渠道列表、连接/断开按钮
5. `link-dev.uni-scrm.com/users` —— 用户表格、列名、筛选
6. `link-dev.uni-scrm.com/list` —— 名单
7. `link-dev.uni-scrm.com/content` —— 内容库
8. `flow-dev.uni-scrm.com/` —— 流程列表、状态列
9. `flow-dev.uni-scrm.com` 打开任一流程 —— **画布节点名、左侧调色板、右侧 Inspector 各字段**（这里是重灾区，要逐个节点类型点开看）
10. `analytics-dev.uni-scrm.com/dashboard` —— 仪表盘
11. `analytics-dev.uni-scrm.com/analytics` —— 报表列表与详情
12. `insight-segment-dev.uni-scrm.com` —— 分群列表与新建
13. `content-dev.uni-scrm.com` —— AI 内容设置
14. **侧边栏**（每页都在）—— 20 个菜单项全中文

- [ ] **Step 6: 确认没有语言闪烁**

在中文状态下强制刷新（Cmd+Shift+R）任意两个模块的页面，观察首屏：**不应先出现英文再跳中文**。这是 Task 1 改 `useLocale` 要解决的问题，此处验收。

- [ ] **Step 7: 切回英文回归**

把语言切回 English，抽查其中 3 个页面，确认英文文案完好——双语机制不能把英文弄坏。

- [ ] **Step 8: 汇报**

向用户汇报：审计计数从基线降到 0、6 个模块部署结果、Step 5 的 14 项逐条结论、Step 6 闪烁验收结果、Step 7 英文回归结果。**不要 push 到 main**——除非用户明确说了 push to main。

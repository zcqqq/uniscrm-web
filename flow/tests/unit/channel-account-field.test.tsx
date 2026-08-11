import { describe, it, expect, vi } from "vitest";
import inspectorSource from "../../frontend/components/Inspector.tsx?raw";
import accountFieldSource from "../../../shared/frontend/components/ChannelAccountField.tsx?raw";

// 这次要挡住的漂移很具体：同一个账号选择器，五个面板写 Account / 账号，两个写
// Target Account / 目标账号。所以第一段断言的是"源码里再也没有人手写账号标签"——
// 渲染测试证明不了这件事（两种写法都能渲染出来），只有源码断言能。
//
// 第二段真渲染共享组件的四态。渲染方式与 refreshable-list.test.ts 同源（helpers/mini-react.ts
// 里写了为什么不能用 react-dom / testing-library），但这里被测的是组件而不是裸 hook：它
// import 了 RefreshButton → radix tooltip，那条链在模块初始化时要用 forwardRef /
// createContext 等 mini-react 没有的 API。所以不整体替换 react，只把 hook 换掉，其余照旧
// 走真 React。子组件只是被构造成 element、并不渲染，radix 自己的 hook 一次都不会跑。
// vi.mock 会被提升到文件顶部，工厂函数得跟着提升，否则「Cannot access before initialization」。
const miniHooks = vi.hoisted(() => async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  const mini = await import("./helpers/mini-react");
  return {
    ...actual,
    useState: mini.useState,
    useEffect: mini.useEffect,
    useMemo: mini.useMemo,
    useCallback: mini.useCallback,
    useRef: mini.useRef,
  };
});
// 两份 react：flow/node_modules 那份（本文件解析到的）和根部 hoist 那份（shared/ 解析到的）。
vi.mock("react", miniHooks);
vi.mock("../../../node_modules/react/index.js", miniHooks);
// locale 固定成 en：useLocale 真跑会去 fetch /api/auth/me，workerd 里相对 URL 直接抛。
vi.mock("../../../shared/frontend/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", timezone: "UTC", loading: false }),
}));

const { renderHook } = await import("./helpers/mini-react");
const { ChannelAccountField } = await import("../../../shared/frontend/components/ChannelAccountField");

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// 1. 源码断言：账号槽里永远是共享组件
// ---------------------------------------------------------------------------
//
// 这里刻意不写成「禁止出现这几个标签字面量」的黑名单，也不写成「遍历这七个面板名」：
// 黑名单只认识今天这几种拼法（en: "Posting Account"、单引号、少个空格都能绕过），
// 名单只认识今天这七个面板，而这次要防的恰恰是**第八个**面板重新手写一遍标签。
// 所以断言的是规则本身：ChannelNodePanel 的 account 槽，要么是 null，要么是
// ChannelAccountField，没有第三种。这条对还不存在的面板同样成立。

function inspectorBody(name: string): string {
  const start = inspectorSource.indexOf(`function ${name}(`);
  expect(start, `Inspector.tsx 里找不到 ${name}`).toBeGreaterThan(-1);
  const rest = inspectorSource.slice(start + 1);
  const next = rest.search(/\n(function|const|export|type) /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 源码里所有 `account={…}` 槽（按花括号配对扫描），带上所属函数名好定位。 */
function accountSlots(source: string): { owner: string; expr: string }[] {
  const slots: { owner: string; expr: string }[] = [];
  const re = /\baccount=\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const from = m.index + "account=".length;
    let depth = 0;
    let end = -1;
    for (let i = from; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    expect(end, `account={ 的花括号没配平（偏移 ${m.index}）`).toBeGreaterThan(-1);
    // 往前找最近的函数声明，失败信息里好指名道姓。
    const before = source.slice(0, m.index);
    const owner = [...before.matchAll(/\nfunction (\w+)\(/g)].pop()?.[1] ?? "<unknown>";
    slots.push({ owner, expr: source.slice(from, end) });
  }
  return slots;
}

describe("账号标签只有一份", () => {
  it("每个 account 槽要么是 null，要么就是 ChannelAccountField——没有第三种", () => {
    const slots = accountSlots(inspectorSource);
    // 每个 ChannelNodePanel 恰好一个 account 槽（该 prop 必填）。数量对不上说明扫描漏了，
    // 那样下面的循环会空转成一条永远绿的断言。
    expect(slots.length).toBe(count(inspectorSource, "<ChannelNodePanel"));
    expect(slots.length).toBeGreaterThanOrEqual(9);

    for (const { owner, expr } of slots) {
      if (expr.trim() === "{null}") continue; // 这个节点没有账号可展示，位置留空
      expect(
        expr,
        `${owner} 的 account 槽没走 ChannelAccountField——账号块又被手写了一遍，标签会再漂一次`
      ).toContain("<ChannelAccountField");
    }
  });

  it("七个账号选择器，两个显式 null", () => {
    const slots = accountSlots(inspectorSource);
    const nulls = slots.filter((s) => s.expr.trim() === "{null}");
    expect(slots.length - nulls.length).toBe(7);
    expect(nulls.length).toBe(2);
  });

  it("标签只在共享组件里出现一次", () => {
    expect(count(accountFieldSource, '{ en: "Account", zh: "账号" }')).toBe(1);
  });

  it("Target Account 是被有意放弃的，共享组件里记着这个决定", () => {
    // 引擎里确实存在「执行账号 ≠ 触发渠道」这层区别（flow/src/index.ts 的 xContentAction），
    // 下一个读到那段的人很可能想把标签改回去。决定写在组件旁边才拦得住。
    expect(accountFieldSource).toContain("Target Account");
    expect(accountFieldSource).toContain("flow/src/index.ts");
  });

  it("两个内容域 action 面板改走可刷新列表，不再直连 api.channels.list", () => {
    // 迁移前它们是 useState + api.channels.list + .catch(() => setChannels([]))：
    // 没有 loading、没有 error、没有刷新，一次 502 就渲染成"尚未绑定账号"。
    for (const name of ["XContentActionInspector", "TikTokContentActionInspector"]) {
      const body = inspectorBody(name);
      expect(body).toContain("useRefreshableList<ChannelOption[]>(channelListFetcher(");
      expect(body).toContain("loading={channelList.loading}");
      expect(body).toContain("error={channelList.error}");
      expect(body).toContain("onRefresh={channelList.refresh}");
      expect(body, `${name} 还在直连 api.channels.list`).not.toContain("api.channels.list(");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 渲染断言：四态 + 只读
// ---------------------------------------------------------------------------

function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) texts(n, out);
    return out;
  }
  if (node && typeof node === "object" && "props" in node) {
    texts((node as { props?: { children?: unknown } }).props?.children, out);
  }
  return out;
}

/** 树里所有 element 的 props，用来找刷新按钮这种「不靠文字辨认」的东西。 */
function allProps(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) allProps(n, out);
    return out;
  }
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props: Record<string, unknown> }).props;
    out.push(props);
    allProps(props.children, out);
  }
  return out;
}

const EMPTY_TEXT = { en: "No X accounts linked", zh: "尚未绑定 X 账号" };

function renderPicker(over: Record<string, unknown>) {
  return renderHook(() =>
    ChannelAccountField({
      value: "",
      onChange: () => {},
      options: null,
      loading: false,
      error: false,
      onRefresh: () => {},
      emptyText: EMPTY_TEXT,
      ...over,
    } as Parameters<typeof ChannelAccountField>[0])
  );
}

describe("ChannelAccountField 的三态", () => {
  it("loading：显示加载中，绝不显示「尚未绑定」", () => {
    // refresh() 会把 data 清成 null。压平成空列表的话，点一下刷新就会闪出「尚未绑定」
    // 并让当前已选账号从下拉框里消失。
    const out = texts(renderPicker({ loading: true, options: null }).current).join("|");
    expect(out).toContain("Account");
    expect(out).toContain("Loading");
    expect(out).not.toContain("No X accounts linked");
  });

  it("error：显示重试文案，与「尚未绑定」互斥", () => {
    // 取不到要用户重试，没绑定要用户去绑定——渲染成同一屏就会让一个早就绑好账号的
    // 用户再去绑一次。
    const out = texts(renderPicker({ error: true, options: null }).current).join("|");
    expect(out).toContain("Could not load your linked accounts. Try again later.");
    expect(out).not.toContain("No X accounts linked");
  });

  it("没取过数（options 为 null 且不 loading 不 error）：什么都不显示，不是「尚未绑定」", () => {
    // useRefreshableList 在 enabled:false 时就是这个状态。把「未知」渲染成「空」是
    // 这条线上已经修过两次的同一个错误，第三处不能因为「今天恰好没人这么调」就留着。
    const out = texts(renderPicker({ options: null }).current).join("|");
    expect(out).toContain("Account");
    expect(out).not.toContain("No X accounts linked");
    expect(out).not.toContain("Loading");
    expect(out).not.toContain("Could not load");
  });

  it("ready 且为空：才显示「尚未绑定」，文案由调用方给（各渠道措辞不同）", () => {
    const out = texts(renderPicker({ options: [] }).current).join("|");
    expect(out).toContain("No X accounts linked");
    expect(out).not.toContain("Could not load");
  });

  it("ready 有数据：渲染 @username 下拉框", () => {
    const el = renderPicker({
      options: [{ id: "c1", username: "acme" }, { id: "c2", username: "beta" }],
      value: "c2",
    }).current;
    const out = texts(el).join("");
    expect(out).toContain("Select account...");
    expect(out).toContain("@acme");
    expect(out).toContain("@beta");
    // 选中值透传，否则用户存过的账号在面板里看不出来。
    expect(allProps(el).some((p) => p.value === "c2")).toBe(true);
  });

  it("onChange 拿到的是 channelId 本身，不是 event", () => {
    const seen: string[] = [];
    const el = renderPicker({
      options: [{ id: "c1", username: "acme" }],
      onChange: (id: string) => seen.push(id),
    }).current;
    const select = allProps(el).find((p) => typeof p.onChange === "function")!;
    (select.onChange as (e: unknown) => void)({ target: { value: "c1" } });
    expect(seen).toEqual(["c1"]);
  });

  it("不传 onRefresh 就没有刷新按钮（列表来源不会在别处被改动时）", () => {
    const withRefresh = allProps(renderPicker({ options: [] }).current);
    expect(withRefresh.some((p) => typeof p.tooltip === "string")).toBe(true);
    const without = allProps(renderPicker({ options: [], onRefresh: undefined }).current);
    expect(without.some((p) => typeof p.tooltip === "string")).toBe(false);
  });

  it("刷新按钮带 tooltip 文案（CLAUDE.md：所有 icon 都要有 tooltip）", () => {
    const props = allProps(renderPicker({ options: [] }).current);
    const refresh = props.find((p) => typeof p.tooltip === "string")!;
    expect(refresh.tooltip).toBe("Reload linked accounts");
  });

  it("只读模式：同一个标签，展示给定文案，没有刷新按钮", () => {
    const el = renderHook(() =>
      ChannelAccountField({ readOnly: true, value: "ch1", displayText: "@octocat" })
    ).current;
    const out = texts(el).join("|");
    expect(out).toContain("Account");
    expect(out).toContain("@octocat");
    expect(allProps(el).some((p) => typeof p.tooltip === "string")).toBe(false);
    expect(allProps(el).some((p) => p.disabled === true)).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { ChannelNodePanel } from "../../../shared/frontend/components/ChannelNodePanel";
import inspectorSource from "../../frontend/components/Inspector.tsx?raw";

// 这个模块的测试跑在 @cloudflare/vitest-pool-workers（workerd）里，没有 document，
// react-dom 挂不上去；@testing-library/react 本仓库也没装。而且 link/node_modules/react
// 与根目录 hoist 的那份 react 是两份拷贝，之前的 agent 已经踩过。
// 所以这里不渲染 DOM，直接调用组件函数拿到 React element 树，按结构断言——
// "account 排到 operation 前面"这件事在 element 树上一样能看见，不需要浏览器。
function textsInOrder(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textsInOrder(n, out);
    return out;
  }
  if (node && typeof node === "object" && "props" in node) {
    textsInOrder((node as { props?: { children?: unknown } }).props?.children, out);
  }
  return out;
}

describe("ChannelNodePanel 强制 operation 在前、account 在后", () => {
  it("按 title → operation → account → children 的固定次序渲染", () => {
    const el = ChannelNodePanel({
      title: "TITLE",
      operation: "OPERATION",
      account: "ACCOUNT",
      children: "EXTRA",
    });
    // 顺序反了（account 在 operation 之前）这条断言就红——
    // 这正是 spec 2026-08-09-channel-node-layout-operation-context-design.md Part 1 要挡住的事。
    expect(textsInOrder(el)).toEqual(["TITLE", "OPERATION", "ACCOUNT", "EXTRA"]);
  });

  it("传入次序与调用者写法无关：account 写在前面也仍然渲染在 operation 之后", () => {
    // 具名 props 没有"书写顺序"这回事——这就是把顺序做成结构而不是约定的意义。
    const el = ChannelNodePanel({
      account: "ACCOUNT",
      operation: "OPERATION",
      title: "TITLE",
      children: "EXTRA",
    });
    const texts = textsInOrder(el);
    expect(texts.indexOf("OPERATION")).toBeLessThan(texts.indexOf("ACCOUNT"));
  });

  it("account 为 null（未连接账号）时位置仍被占住，children 不会顶成位置二", () => {
    const el = ChannelNodePanel({
      title: "TITLE",
      operation: "OPERATION",
      account: null,
      children: "EXTRA",
    });
    const container = (el as { props: { children: unknown[] } }).props.children[1] as {
      props: { children: unknown[] };
    };
    // 三个槽位恒定存在：operation / account / children，account 只是渲染成 null。
    expect(container.props.children).toHaveLength(3);
    expect(container.props.children[1]).toBeNull();
    expect(textsInOrder(el)).toEqual(["TITLE", "OPERATION", "EXTRA"]);
  });

  it("多个 children 全部落在 account 之后", () => {
    const el = ChannelNodePanel({
      title: "TITLE",
      operation: "OPERATION",
      account: "ACCOUNT",
      children: ["A", "B"],
    });
    expect(textsInOrder(el)).toEqual(["TITLE", "OPERATION", "ACCOUNT", "A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// 上面只证明了组件本身，证明不了"每个渠道节点面板都真的用了它"——面板换回手写
// div + h4 的那一刻，上面全绿。所以这一段针对 Inspector.tsx 里每个渠道节点面板断言。
//
// 为什么断言源码而不是渲染：本模块测试跑在 @cloudflare/vitest-pool-workers（workerd），
// 没有 document，react-dom 挂不上；@testing-library/react 与 react-test-renderer 本仓库
// 都没装；而且这些 Inspector 组件既没导出、又用 useState/useEffect，脱离 renderer 直接
// 调用会 "Invalid hook call"。所以用 vite 的 ?raw 把源码读进来做结构断言：
// "用了 ChannelNodePanel" + "操作块在 operation 槽、账号块在 account 槽" 这两件事，
// 在源码结构上是可判定的，也正是这次迁移要锁住的东西。
function inspectorBody(name: string): string {
  const start = inspectorSource.indexOf(`function ${name}(`);
  expect(start, `Inspector.tsx 里找不到 ${name}`).toBeGreaterThan(-1);
  const rest = inspectorSource.slice(start + 1);
  // 顶格的下一个 function / const / export / type 声明就是本函数的结束（内层声明都有缩进）。
  const next = rest.search(/\n(function|const|export|type) /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 取出 `<prop>={ ... }` 里那段 JSX 表达式（按花括号配对扫描）。 */
function propExpr(body: string, prop: string): string {
  const at = body.indexOf(`${prop}={`);
  expect(at, `找不到 ${prop}= 这个具名槽位`).toBeGreaterThan(-1);
  let i = at + `${prop}=`.length;
  let depth = 0;
  const from = i;
  for (; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) return body.slice(from, i + 1);
    }
  }
  throw new Error(`${prop}= 的花括号没配平`);
}

// 名字 → [操作块里必须出现的标签, 账号块里必须出现的标记或 null]
//
// 账号块的标记不再是标签文案本身：标签已经收进 shared 的 ChannelAccountField，面板里
// 一个字都不写（见 channel-account-field.test.tsx）。这里改断言"account 槽里放的是那个
// 共享组件"，它同样能证明账号块没跑到 operation 槽里去。
const ACCOUNT_FIELD = "<ChannelAccountField";
const CHANNEL_NODE_PANELS: [string, string, string | null][] = [
  // 迁移前就在用（参照实现）
  ["YouTubeContentTriggerInspector", 'en: "Event"', ACCOUNT_FIELD],
  ["GitHubContentTriggerInspector", 'en: "Event"', ACCOUNT_FIELD],
  // 本次迁移
  ["XTriggerInspector", 'en: "Event"', ACCOUNT_FIELD],
  // Message 块原本夹在动作块与账号块之间，迁移后落到账号之后（用户拍板：宁可挪一个
  // 字段，也不留一个手写面板当反面样板）。出现条件 data.xEvent === "create-dm" 不变。
  ["XActionInspector", 'en: "Action"', ACCOUNT_FIELD],
  ["XContentTriggerInspector", 'en: "Event"', ACCOUNT_FIELD],
  ["XContentActionInspector", 'en: "Operation"', ACCOUNT_FIELD],
  ["TikTokContentActionInspector", 'en: "Operation"', ACCOUNT_FIELD],
  // 没有账号选择器：account={null} 把位置二占住，后面的块不会顶上来
  ["YouTubeContentActionInspector", 'en: "Operation"', null],
  ["VideoActionInspector", 'en: "Operation"', null],
];

describe("Inspector.tsx 的渠道节点面板都走 ChannelNodePanel", () => {
  for (const [name, operationLabel, accountLabel] of CHANNEL_NODE_PANELS) {
    it(`${name}：操作块在 operation 槽、账号块在 account 槽`, () => {
      const body = inspectorBody(name);
      expect(body).toContain("<ChannelNodePanel");
      // 手写骨架会让顺序重新变成"靠人记住"——这正是组件要消灭的东西。
      expect(body).not.toContain('<h4 className="text-sm font-semibold text-primary mb-3">');

      const operation = propExpr(body, "operation");
      expect(operation, `${name} 的 operation 槽里不是操作块`).toContain(operationLabel);

      if (accountLabel === null) {
        // 没账号可展示时必须显式传 null，而不是省略 —— 省略是类型错误，占位才是本意。
        expect(body).toContain("account={null}");
      } else {
        const account = propExpr(body, "account");
        expect(account, `${name} 的 account 槽里不是账号块`).toContain(accountLabel);
        // 账号块不能跑到操作槽里去（那样渲染出来账号就排在操作前面了）。
        expect(operation).not.toContain(accountLabel);
      }
    });
  }
});

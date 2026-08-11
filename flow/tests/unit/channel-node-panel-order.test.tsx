import { describe, it, expect } from "vitest";
import { ChannelNodePanel } from "../../../shared/frontend/components/ChannelNodePanel";

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

// 渠道节点编辑面板的固定骨架：标题 → 操作(operation) → 渠道账号(account) → 其余内容。
//
// 为什么是一个组件而不是一条注释约定：
// docs/superpowers/specs/2026-08-09-channel-node-layout-operation-context-design.md 的 Part 1
// 规定「每个渠道节点的编辑面板，操作列表在前、账号列表在后」。这条顺序此前是每写一个节点
// 面板就靠人重新推导一遍，已经错过不止一次（X / TikTok Content Action 两个面板顺序颠倒；
// GitHub Release 触发器干脆没有账号块）。只写文档挡不住下一次。
//
// 所以这里把顺序变成结构：operation 与 account 是具名 props，由本组件按固定次序渲染，
// 调用方在物理上无法把账号块排到操作块之前——它没有表达那个顺序的语法。剩下的一切走
// children，永远落在这两块之后。
//
// account 是必填的（可以传 null 表示"这个节点此刻没有账号可展示"），这样"忘了账号块"
// 是一个类型错误，而不是一个静悄悄少了一块 UI 的面板。

interface ChannelNodePanelProps {
  /** 面板标题，通常是 T(nodeLabel(...)) 的结果。 */
  title: React.ReactNode;
  /** 位置一：操作 / 事件块。 */
  operation: React.ReactNode;
  /**
   * 位置二：渠道账号块。未连接账号时传 null——位置仍由本组件占住，
   * 后面的块不会顶上来变成"位置二"。
   */
  account: React.ReactNode;
  /** 位置二之后的一切：资源选择器、开关、说明文字、条件编辑器等。 */
  children?: React.ReactNode;
}

export function ChannelNodePanel({ title, operation, account, children }: ChannelNodePanelProps) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-primary mb-3">{title}</h4>
      <div className="space-y-3">
        {operation}
        {account}
        {children}
      </div>
    </div>
  );
}

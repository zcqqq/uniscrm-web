import { describe, it, expect } from "vitest";
import { NODE_TYPE_REGISTRY } from "../../nodeTypeRegistry";
import { NODE_TYPE_LABELS, nodeLabel, nodeDescription } from "../../frontend/config/nodeTypeLabels";

describe("NODE_TYPE_LABELS", () => {
  // 注册表是禁改文件，映射表在外面——两者必须一一对应。
  // 将来注册表加了节点而这里漏加，画布上就会冒出一个英文标签，这个测试就是那道闸。
  //
  // 例外：xTrigger。它的 label 在注册表里就是动态拼出来的（按 channelType，源头在
  // CHANNEL_TYPES），注册表本身没给它静态 label——所以覆盖检查只看"注册表里有 label 的节点"，
  // 不是注册表的全部 key。别为了让这条测试"更严格"就把 xTrigger 加回来，那会在这张静态表里
  // 造出一个从未生效的假译文。
  it("覆盖注册表里每一个有 label 的节点类型", () => {
    for (const [nodeType, def] of Object.entries(NODE_TYPE_REGISTRY)) {
      if (!(def as any).label) continue;
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

  // 但凡写了 description，两种语言就都得有（包括 5 个模板串节点存的 "{n}" 占位模式）。
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

  // 5 个模板串节点（如 xAction）存的是带 "{n}" 占位符的模式；nodeDescription 的第二个参数是
  // 注册表算好的原始英文（如 "5 actions"），要把开头的数字抠出来代进占位符。
  it("nodeDescription 把注册表算好的数字代入模板占位符", () => {
    const result = nodeDescription("xAction", "5 actions");
    expect(result?.en).toBe("5 actions");
    expect(result?.zh).toBe("5 个动作");
  });

  it("nodeDescription 在注册表文本里找不到数字时，去掉占位符而不是显示字面 {n}", () => {
    const result = nodeDescription("xAction", "no actions available");
    expect(result?.en).toBe("actions");
    expect(result?.zh).toBe("个动作");
  });
});

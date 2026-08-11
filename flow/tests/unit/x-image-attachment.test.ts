import { describe, it, expect } from "vitest";
import { findXImageVideoConflictIds, validateFlowGraph } from "../../frontend/lib/validate-flow-graph";
import inspectorSource from "../../frontend/components/Inspector.tsx?raw";
import editorSource from "../../frontend/pages/EditorPage.tsx?raw";

describe("X 图片/视频互斥的发布校验", () => {
  // 真实保存的图形状：action 家族在 React Flow 里统一收敛成 node.type === "action"，
  // 具体是哪种 action 记在 data.actionType 上（nodeTypeRegistry.ts 的 reactFlowType 注释）。
  // 这里曾经写成 { type: "xContentAction", data } ——那个假 node.type 恰好等于本函数
  // 曾经错判的字符串，让测试和实现互相印证了同一个错误，谁都没能发现 filter 恒为空。
  const node = (data: Record<string, unknown>) => ({
    id: "n1",
    type: "action",
    data: { actionType: "xContentAction", ...data },
  });

  it("同时勾了图片与视频的 create-post 节点被拦下", () => {
    expect(findXImageVideoConflictIds([node({ operation: "create-post", attachImage: true, attachVideo: true })])).toEqual(["n1"]);
  });

  it("只勾一个、或一个都不勾，都放行", () => {
    expect(findXImageVideoConflictIds([node({ operation: "create-post", attachImage: true })])).toEqual([]);
    expect(findXImageVideoConflictIds([node({ operation: "create-post", attachVideo: true })])).toEqual([]);
    expect(findXImageVideoConflictIds([node({ operation: "create-post" })])).toEqual([]);
  });

  // 别的 operation（bookmark / like / repost）根本没有媒体字段，畸形图里残留的
  // attachImage 不该把一个本来合法的节点拦在发布之外。
  it("不管非 create-post 的操作", () => {
    expect(findXImageVideoConflictIds([node({ operation: "like-post", attachImage: true, attachVideo: true })])).toEqual([]);
  });

  // 别的 actionType（如 tiktokContentAction）即便同样带 attachImage/attachVideo，也不该被
  // 当成 X 节点拦下——这两个字段只对 xContentAction 有媒体互斥的含义。
  it("不管别的 actionType", () => {
    expect(
      findXImageVideoConflictIds([
        { id: "n1", type: "action", data: { actionType: "tiktokContentAction", operation: "create-post", attachImage: true, attachVideo: true } },
      ])
    ).toEqual([]);
  });

  // 回归用例：判据必须是 data.actionType，不能退回判 node.type。旧的错误实现里
  // node.type === "xContentAction" 从未在真实图里为真，把这个 filter 变成死代码——
  // 发布时永远放行，无论两个勾选框是否同时勾中。撤回本次修复会让这条用例变红。
  it("判据是 data.actionType，不是 node.type", () => {
    const oldWrongShape = { id: "wrong", type: "xContentAction", data: { attachImage: true, attachVideo: true } };
    const realShape = node({ operation: "create-post", attachImage: true, attachVideo: true });
    expect(findXImageVideoConflictIds([oldWrongShape, realShape])).toEqual(["n1"]);
  });

  it("冲突会让整张图 invalid，并出现在返回值里", () => {
    const result = validateFlowGraph(
      [{ id: "t1", type: "xContentTrigger", data: {} },
       node({ operation: "create-post", attachImage: true, attachVideo: true })],
      [{ source: "t1", target: "n1" }]
    );
    expect(result.valid).toBe(false);
    expect(result.xMediaConflictNodeIds).toEqual(["n1"]);
  });
});

describe("X 图片块的接线", () => {
  it("图片勾选框排在视频勾选框之前，两者都有双语文案", () => {
    const imageIdx = inspectorSource.indexOf("Attach AI-generated image");
    const videoIdx = inspectorSource.indexOf("Attach video (uses this flow's processed video, if any)");
    expect(imageIdx).toBeGreaterThan(-1);
    expect(imageIdx).toBeLessThan(videoIdx);
    expect(inspectorSource).toContain("附加 AI 生成的图片");
  });

  it("两个图片 provider 下拉都来自 /api/image-providers，没有写死 gpt-image-1", () => {
    // 写死模型名意味着设置页选的图片模型不生效——这正是本次要消灭的东西。
    expect(inspectorSource).toContain("api.imageProviders.list()");
    expect(inspectorSource).not.toContain("gpt-image-1");
  });

  // Task 10: a 2271-character GitHub release body, once interpolated into a user-written prompt
  // template ("抽象科技风插画，基于内容：$content.content_text"), produced a 2284-character
  // prompt — over flux's 2048 limit — and silently degraded to text-only. Removing the field
  // (not just guarding its length) makes that failure mode structurally impossible: content's
  // stage 1 now reads the source content itself and writes the visual description.
  it("节点面板不再有图片提示词输入框", () => {
    expect(inspectorSource).not.toContain("imagePrompt");
    expect(inspectorSource).not.toContain("抽象科技风插画");
  });

  it("TikTok 的 Image Skill 下拉已经拿掉", () => {
    expect(inspectorSource).not.toContain('{ en: "Image Skill", zh: "图片技能" }');
    expect(inspectorSource).not.toContain("imageSkillId");
  });

  it("发布失败的提示为媒体冲突单列一条文案", () => {
    expect(editorSource).toContain("xMediaConflictNodeIds");
    expect(editorSource).toContain("can only attach either an image or a video");
  });
});

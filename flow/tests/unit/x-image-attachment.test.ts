import { describe, it, expect } from "vitest";
import { findXImageVideoConflictIds, validateFlowGraph } from "../../frontend/lib/validate-flow-graph";
import inspectorSource from "../../frontend/components/Inspector.tsx?raw";
import editorSource from "../../frontend/pages/EditorPage.tsx?raw";

describe("X 图片/视频互斥的发布校验", () => {
  const node = (data: Record<string, unknown>) => ({ id: "n1", type: "xContentAction", data });

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

  it("冲突会让整张图 invalid，并出现在返回值里", () => {
    const result = validateFlowGraph(
      [{ id: "t1", type: "xContentTrigger", data: {} },
       { id: "n1", type: "xContentAction", data: { operation: "create-post", attachImage: true, attachVideo: true } }],
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

  it("TikTok 的 Image Skill 下拉已经拿掉", () => {
    expect(inspectorSource).not.toContain('{ en: "Image Skill", zh: "图片技能" }');
    expect(inspectorSource).not.toContain("imageSkillId");
  });

  it("发布失败的提示为媒体冲突单列一条文案", () => {
    expect(editorSource).toContain("xMediaConflictNodeIds");
    expect(editorSource).toContain("can only attach either an image or a video");
  });
});

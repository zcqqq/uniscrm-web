import { describe, it, expect } from "vitest";
import settingsSource from "../frontend/pages/SettingsPage.tsx?raw";
import apiSource from "../frontend/lib/api.ts?raw";

// 这个页面用 hook，workerd 里没有 document、仓库也没装 @testing-library/react
// （见 flow/tests/unit/channel-node-panel-order.test.tsx 的说明），所以这里只守接线约定：
// 真正的判定逻辑（哪些 provider 有图片模型）活在 content 的 /api/image-providers，
// 已由 routes-api-image-providers.test.ts 真跑。
describe("AI Content Settings 的图片模型接线", () => {
  it("api client 会带 kind 请求模型列表，并把 imageModel 一起存下", () => {
    expect(apiSource).toContain('kind?: "text" | "image"');
    expect(apiSource).toContain("imageModel");
  });

  it("Image model 选择器有双语标签", () => {
    expect(settingsSource).toContain('{ en: "Image model", zh: "图片模型" }');
  });

  // 列表为空时整块不渲染 —— Anthropic 卡上因此不会出现一个永远选不出东西的空下拉框，
  // 也不需要任何 "该 provider 没有图片模型" 的说明文案（spec §2.3）。
  it("图片模型列表为空时不渲染选择器，且没有写死 provider 名的说明文案", () => {
    expect(settingsSource).toContain("imageModels.length > 0 && (");
    expect(settingsSource).not.toContain("Anthropic has no image");
  });
});

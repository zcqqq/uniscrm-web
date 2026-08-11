import { describe, it, expect } from "vitest";
import { extractContextBlock } from "../frontend/lib/context-block";

const S = "PRODUCT-MARKETING-CONTEXT-V1";

describe("extractContextBlock", () => {
  it("取出带哨兵的完整块", () => {
    const reply = `聊得差不多了，这是文档：\n\n\`\`\`${S}\n# Product Marketing Context\n\n## Product Overview\nUniSCRM ...\n\`\`\`\n\n还需要改什么？`;
    expect(extractContextBlock(reply)).toBe("# Product Marketing Context\n\n## Product Overview\nUniSCRM ...");
  });

  // 这是不自动保存的技术前提：块没闭合就是没写完，存下去等于把半份文档灌进此后所有生成。
  it("围栏没闭合时返回 null", () => {
    expect(extractContextBlock(`\`\`\`${S}\n# Product Marketing Context\n## Product Overview`)).toBeNull();
  });

  it("普通 markdown 块不算数", () => {
    expect(extractContextBlock("举个例子：\n\n```markdown\n# 标题\n```")).toBeNull();
    expect(extractContextBlock("```\n# 无标签\n```")).toBeNull();
  });

  it("块内容为空白时返回 null", () => {
    expect(extractContextBlock(`\`\`\`${S}\n   \n\`\`\``)).toBeNull();
  });

  it("没有块时返回 null", () => {
    expect(extractContextBlock("你的目标客户是谁？")).toBeNull();
  });
});

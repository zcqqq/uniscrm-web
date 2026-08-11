import { describe, it, expect } from "vitest";
import { extractContextBlock } from "../frontend/lib/context-block";
import contextBlockSource from "../frontend/lib/context-block.ts?raw";

// 字面量写在这里、不 import CONTEXT_SENTINEL——这样如果哪天有人把 shared 里的常量改错了，
// 这个断言（连同 routes-api-marketing-context.test.ts 里后端那侧的字面量断言）才会真的红，
// 而不是"测试和被测代码从同一个错误常量里各抄一份，永远对得上"。
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

  // 回归：非贪婪正则会在嵌套围栏的收口处就误判为外层块收口，把"more content"静默截掉。
  it("正文里嵌套的围栏（比如示例代码块）不会截断外层块", () => {
    const reply = `\`\`\`${S}\n# Doc\n\`\`\`js\nconst a = 1;\n\`\`\`\nmore content\n\`\`\``;
    expect(extractContextBlock(reply)).toBe("# Doc\n```js\nconst a = 1;\n```\nmore content");
  });

  // 回归：开栏行必须整行精确匹配，"以哨兵开头"不算——否则未来的 V10 会被当成 V1 收掉。
  it("info string 只是以哨兵开头（如未来的 V10）时不算数", () => {
    expect(extractContextBlock(`\`\`\`${S}0\n# Doc\n\`\`\``)).toBeNull();
  });

  // 行为选择并锁定：一条回复里出现两个哨兵块，只认第一个开栏行；哪怕它没闭合、
  // 后面那个闭合了，也不退而取第二个——"哪个块生效"不该靠解析器去猜。
  it("一条回复里两个哨兵块：只认第一个，且必须是它自己闭合", () => {
    const twoClosedBlocks = `before\n\`\`\`${S}\nFIRST\n\`\`\`\nmiddle\n\`\`\`${S}\nSECOND\n\`\`\`\nafter`;
    expect(extractContextBlock(twoClosedBlocks)).toBe("FIRST");

    const firstUnclosedSecondClosed = `\`\`\`${S}\nFIRST UNCLOSED\nmiddle\n\`\`\`${S}\nSECOND\n\`\`\``;
    expect(extractContextBlock(firstUnclosedSecondClosed)).toBeNull();
  });

  it("哨兵常量来自 shared/，不是模块本地再声明一份字面量", () => {
    expect(contextBlockSource).toContain('from "../../../shared/marketing-context-sentinel"');
    expect(contextBlockSource).not.toContain(`"${S}"`);
  });
});
